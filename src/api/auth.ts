import { logged } from '../core/log.js';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Router, Request, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import QRCode from 'qrcode';
import { isRole, type Principal, type Role } from './roles.js';
import { FailureLimiter, fullPath } from './security.js';
import { currentStep, generateSecret, otpauthUri, verifyTotp } from './totp.js';

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export interface DevLogAuth {
  username: string;
  password: string;
  /** TOTP-Schlüssel des Systemadministrators (.env); beim Start aus der Datenbank geladen. */
  totpSecret?: string | null;
}

export const SESSION_COOKIE = 'devlog_session';
const SESSION_DAYS = 30;
const TOTP_KEY = 'auth_totp_secret';
const TOTP_PENDING_KEY = 'auth_totp_pending';
/** Zuletzt angenommener TOTP-Zeitschritt je Konto – derselbe Code gilt nur einmal. */
const lastTotpSteps = new Map<string, number>();

function equalSecret(received: string, expected: string): boolean {
  const actualBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

/** Passwort-Hash im Format scrypt$<salt>$<hash> (Base64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Ein fester Dummy-Hash, damit unbekannte Benutzernamen genauso lange brauchen wie falsche Passwörter. */
let dummyHash: Promise<string> | null = null;

export function systemAdmin(auth: DevLogAuth): Principal {
  return { id: null, username: auth.username, displayName: 'Systemadministrator', roles: ['admin'] };
}

function basicCredentials(header: string | undefined): [string, string] | null {
  if (!header?.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    return separator >= 0 ? [decoded.slice(0, separator), decoded.slice(separator + 1)] : null;
  } catch {
    return null;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function sessionToken(request: Request): string | null {
  for (const part of (request.get('cookie') ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === SESSION_COOKIE && value.length) return decodeURIComponent(value.join('='));
  }
  return null;
}

function setSessionCookie(request: Request, response: Response, token: string, maxAgeSeconds: number): void {
  const secure = request.secure ? '; Secure' : '';
  response.set(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`,
  );
}

/** Lädt den TOTP-Schlüssel des Systemadministrators (fehlt die Tabelle noch, gilt: kein zweiter Faktor). */
export async function loadTotpSecret(pool: Pool): Promise<string | null> {
  // Only a missing table (fresh database) means no second factor; any other error must not switch it off.
  const result = await pool
    .query<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', [TOTP_KEY])
    .catch((error: { code?: string }) => {
      if (error.code === '42P01') return null;
      throw error;
    });
  return result?.rows[0]?.value ?? null;
}

/** Prüft einen TOTP-Code und verhindert, dass derselbe Code zweimal angenommen wird. */
function acceptCode(account: string, secret: string, code: unknown): boolean {
  if (typeof code !== 'string') return false;
  const step = verifyTotp(secret, code);
  if (step === null || step <= (lastTotpSteps.get(account) ?? -1)) return false;
  lastTotpSteps.set(account, step);
  return true;
}

const roleList = (roles: unknown): Role[] => (Array.isArray(roles) ? roles.filter(isRole) : []);

/**
 * Schlüssel für die Fehlversuch-Sperre: Konto und Adresse. Hinter Docker Desktop erscheinen alle Zugriffe von aussen
 * mit derselben IP – eine Sperre nur nach IP träfe dann alle Geräte gleichzeitig.
 */
function attemptKey(ip: string | undefined, username: unknown): string {
  const name = typeof username === 'string' ? username.trim().toLowerCase().slice(0, 80) : '';
  return `${ip ?? 'unknown'}|${name}`;
}

/** Angemeldeter Benutzer zur Sitzung (null = ungültig, abgelaufen oder Benutzer deaktiviert). */
async function sessionPrincipal(pool: Pool, auth: DevLogAuth, token: string): Promise<Principal | null> {
  const result = await pool.query<{
    last_seen: Date;
    user_id: string | null;
    username: string | null;
    display_name: string | null;
    roles: string[] | null;
    active: boolean | null;
  }>(
    `SELECT s.last_seen, s.user_id, u.username, u.display_name, u.roles, u.active
       FROM auth_sessions s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [hashToken(token)],
  );
  const session = result.rows[0];
  if (!session) return null;
  if (session.user_id && !session.active) return null;
  if (Date.now() - new Date(session.last_seen).getTime() > 10 * 60 * 1000) {
    await pool.query('UPDATE auth_sessions SET last_seen = NOW() WHERE token_hash = $1', [hashToken(token)]);
  }
  return session.user_id
    ? {
        id: session.user_id,
        username: session.username ?? '',
        displayName: session.display_name || session.username || '',
        roles: roleList(session.roles),
      }
    : systemAdmin(auth);
}

/**
 * Anmeldung: Sitzungs-Cookie aus der Login-Seite. Basic Auth (für Skripte) gilt nur für den Systemadministrator und
 * nur, solange dort kein zweiter Faktor eingerichtet ist. Oberfläche und Dateien bleiben öffentlich, geschützt ist
 * die API. Der angemeldete Benutzer steht danach in res.locals.principal.
 */
export function requireCredentials(auth: DevLogAuth, pool: Pool, limiter = new FailureLimiter()): RequestHandler {
  return async (request, response, next) => {
    if (!fullPath(request).startsWith('/api/')) {
      next();
      return;
    }
    response.set('Cache-Control', 'no-store');
    try {
      // Gültige Sitzungen werden nie gesperrt – die Sperre betrifft nur Anmeldeversuche.
      const token = sessionToken(request);
      const principal = token ? await sessionPrincipal(pool, auth, token) : null;
      if (principal) {
        response.locals.principal = principal;
        next();
        return;
      }
      const basic = basicCredentials(request.get('authorization'));
      // Basic Auth (nur für Skripte) gilt nur ohne zweiten Faktor. Mit zweitem Faktor wird ein mitgeschickter
      // Header ignoriert statt gezählt: Browser senden alte, zwischengespeicherte Zugangsdaten bei jeder Anfrage
      // automatisch mit – das würde sonst sofort das Konto sperren. Eigener Schlüssel, damit die Login-Seite frei bleibt.
      if (basic && !auth.totpSecret) {
        const client = `basic|${attemptKey(request.ip, basic[0])}`;
        if (limiter.isBlocked(client)) {
          response.status(429).json({ message: 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.' });
          return;
        }
        if (equalSecret(basic[0], auth.username) && equalSecret(basic[1], auth.password)) {
          limiter.reset(client);
          response.locals.principal = systemAdmin(auth);
          next();
          return;
        }
        limiter.recordFailure(client);
      }
      response.status(401).json({ message: 'Anmeldung erforderlich.' });
    } catch (error) {
      next(error);
    }
  };
}

interface Account {
  principal: Principal;
  /** Schlüssel für die Einmal-Code-Sperre */
  key: string;
  totpSecret: string | null;
}

/** Prüft Benutzername und Passwort – zuerst Systemadministrator (.env), dann Benutzer aus der Datenbank. */
async function findAccount(
  pool: Pool,
  auth: DevLogAuth,
  username: unknown,
  password: unknown,
): Promise<Account | null> {
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  if (equalSecret(username, auth.username)) {
    return equalSecret(password, auth.password)
      ? { principal: systemAdmin(auth), key: 'system', totpSecret: auth.totpSecret ?? null }
      : null;
  }
  const user = (
    await pool
      .query<{
        id: string;
        username: string;
        display_name: string;
        password_hash: string;
        roles: string[];
        totp_secret: string | null;
      }>(
        `SELECT id, username, display_name, password_hash, roles, totp_secret FROM users
          WHERE lower(username) = lower($1) AND active`,
        [username.trim()],
      )
      .catch(logged('auth', { rows: [] }))
  ).rows[0];
  if (!user) {
    dummyHash ??= hashPassword('dummy-password-for-timing');
    await verifyPassword(password, await dummyHash);
    return null;
  }
  if (!(await verifyPassword(password, user.password_hash))) return null;
  return {
    principal: {
      id: user.id,
      username: user.username,
      displayName: user.display_name || user.username,
      roles: roleList(user.roles),
    },
    key: user.id,
    totpSecret: user.totp_secret,
  };
}

/** Öffentliche Anmelde-Routen; vor requireCredentials registrieren. */
export function registerLoginRoutes(app: Router, pool: Pool, auth: DevLogAuth, limiter: FailureLimiter): void {
  app.get('/session', async (request, response, next) => {
    try {
      const token = sessionToken(request);
      const principal = token ? await sessionPrincipal(pool, auth, token) : null;
      response.set('Cache-Control', 'no-store');
      response.json({
        authenticated: Boolean(principal),
        authRequired: true,
        totp: Boolean(auth.totpSecret),
        user: principal,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/login', async (request, response, next) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const client = attemptKey(request.ip, body.username);
      if (limiter.isBlocked(client)) {
        response
          .status(429)
          .json({ message: 'Zu viele Fehlversuche für dieses Konto. Bitte in 15 Minuten erneut versuchen.' });
        return;
      }
      const account = await findAccount(pool, auth, body.username, body.password);
      if (account?.totpSecret && !body.code) {
        // Passwort stimmt, es fehlt nur der Code – die Login-Seite fragt danach (kein Fehlversuch).
        response.status(401).json({ message: 'Bitte den Code aus der Authenticator-App eingeben.', totp: true });
        return;
      }
      const codeOk = !account?.totpSecret || acceptCode(account.key, account.totpSecret, body.code);
      if (!account || !codeOk) {
        limiter.recordFailure(client);
        const message =
          account && account.totpSecret
            ? 'Der Code aus der Authenticator-App stimmt nicht.'
            : 'Benutzername oder Passwort stimmen nicht.';
        response.status(401).json({ message, totp: Boolean(account?.totpSecret) });
        return;
      }
      limiter.reset(client);
      const token = randomBytes(32).toString('base64url');
      await pool.query(
        `INSERT INTO auth_sessions (token_hash, expires_at, user_agent, user_id)
         VALUES ($1, NOW() + make_interval(days => $2), $3, $4)`,
        [hashToken(token), SESSION_DAYS, (request.get('user-agent') ?? '').slice(0, 300), account.principal.id],
      );
      if (account.principal.id) {
        await pool
          .query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [account.principal.id])
          .catch(logged('auth'));
      }
      setSessionCookie(request, response, token, SESSION_DAYS * 24 * 3600);
      response.json({ authenticated: true, user: account.principal });
    } catch (error) {
      next(error);
    }
  });

  app.post('/logout', async (request, response, next) => {
    try {
      const token = sessionToken(request);
      if (token) await pool.query('DELETE FROM auth_sessions WHERE token_hash = $1', [hashToken(token)]);
      setSessionCookie(request, response, '', 0);
      response.json({ authenticated: false });
    } catch (error) {
      next(error);
    }
  });
}

/** Zwei-Faktor einrichten/abschalten und andere Geräte abmelden – jeweils für das eigene Konto. */
export function registerSecurityRoutes(app: Router, pool: Pool, auth: DevLogAuth): void {
  const principalOf = (response: Response): Principal => response.locals.principal as Principal;
  const totpOf = async (principal: Principal): Promise<string | null> =>
    principal.id
      ? ((
          await pool.query<{ secret: string | null }>('SELECT totp_secret AS secret FROM users WHERE id = $1', [
            principal.id,
          ])
        ).rows[0]?.secret ?? null)
      : (auth.totpSecret ?? null);

  app.get('/auth/status', async (request, response, next) => {
    try {
      const principal = principalOf(response);
      const sessions = await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM auth_sessions WHERE expires_at > NOW() AND user_id IS NOT DISTINCT FROM $1',
        [principal.id],
      );
      response.json({
        totp: Boolean(await totpOf(principal)),
        sessions: Number(sessions.rows[0]?.count ?? 0),
        sessionLogin: Boolean(sessionToken(request)),
        user: principal,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/auth/totp/setup', async (_request, response, next) => {
    try {
      const principal = principalOf(response);
      const secret = generateSecret();
      if (principal.id) {
        await pool.query('UPDATE users SET totp_pending = $2 WHERE id = $1', [principal.id, secret]);
      } else {
        await pool.query(
          `INSERT INTO app_settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [TOTP_PENDING_KEY, secret],
        );
      }
      const uri = otpauthUri(secret, principal.username);
      const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240, color: { dark: '#202824', light: '#ffffff' } });
      response.json({ secret, uri, qr });
    } catch (error) {
      next(error);
    }
  });

  app.post('/auth/totp/enable', async (request, response, next) => {
    try {
      const principal = principalOf(response);
      const pending = principal.id
        ? (
            await pool.query<{ value: string | null }>('SELECT totp_pending AS value FROM users WHERE id = $1', [
              principal.id,
            ])
          ).rows[0]?.value
        : (await pool.query<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', [TOTP_PENDING_KEY]))
            .rows[0]?.value;
      const code = (request.body as { code?: unknown } | undefined)?.code;
      if (!pending || typeof code !== 'string' || verifyTotp(pending, code) === null) {
        response.status(400).json({ message: 'Der Code stimmt nicht. Bitte den aktuellen Code aus der App eingeben.' });
        return;
      }
      if (principal.id) {
        await pool.query('UPDATE users SET totp_secret = totp_pending, totp_pending = NULL WHERE id = $1', [
          principal.id,
        ]);
      } else {
        await pool.query(
          `INSERT INTO app_settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [TOTP_KEY, pending],
        );
        await pool.query('DELETE FROM app_settings WHERE key = $1', [TOTP_PENDING_KEY]);
        auth.totpSecret = pending;
      }
      lastTotpSteps.set(principal.id ?? 'system', currentStep());
      // Sitzungen dieses Kontos, die nur mit Passwort entstanden sind, gelten nicht mehr – außer der aktuellen.
      const token = sessionToken(request);
      await pool.query('DELETE FROM auth_sessions WHERE token_hash <> $1 AND user_id IS NOT DISTINCT FROM $2', [
        token ? hashToken(token) : '',
        principal.id,
      ]);
      response.json({ totp: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/auth/totp/disable', async (request, response, next) => {
    try {
      const principal = principalOf(response);
      const secret = await totpOf(principal);
      const code = (request.body as { code?: unknown } | undefined)?.code;
      if (!secret || !acceptCode(principal.id ?? 'system', secret, code)) {
        response.status(400).json({ message: 'Der Code stimmt nicht.' });
        return;
      }
      if (principal.id) {
        await pool.query('UPDATE users SET totp_secret = NULL WHERE id = $1', [principal.id]);
      } else {
        await pool.query('DELETE FROM app_settings WHERE key = $1', [TOTP_KEY]);
        auth.totpSecret = null;
      }
      response.json({ totp: false });
    } catch (error) {
      next(error);
    }
  });

  app.post('/auth/logout-others', async (request, response, next) => {
    try {
      const token = sessionToken(request);
      const result = await pool.query(
        'DELETE FROM auth_sessions WHERE token_hash <> $1 AND user_id IS NOT DISTINCT FROM $2',
        [token ? hashToken(token) : '', principalOf(response).id],
      );
      response.json({ removed: result.rowCount ?? 0 });
    } catch (error) {
      next(error);
    }
  });
}
