import { logged } from '../core/log.js';
import { decryptSecret, encryptSecret, isEncrypted } from '../core/secrets.js';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Router, Request, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import QRCode from 'qrcode';
import { isRole, type Principal, type Role } from './roles.js';
import { FailureLimiter, clientSource, fullPath } from './security.js';
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
/** Abgelaufene und ungültige Sitzungen werden stündlich gelöscht. */
const SESSION_CLEANUP_MS = 60 * 60 * 1000;

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

/** Ein scrypt-Vergleich ohne Ergebnis – nur für gleiche Antwortzeiten. */
async function dummyVerify(password: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(password, await dummyHash);
}

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

/** Ohne DEV_LOG_SECRET_KEY lässt sich kein TOTP-Schlüssel verschlüsselt speichern. */
export class TotpKeyMissingError extends Error {
  constructor() {
    super('Zwei-Faktor-Schlüssel brauchen DEV_LOG_SECRET_KEY. Den Schlüssel in der .env setzen und neu starten.');
  }
}

/** TOTP-Schlüssel kommen nur verschlüsselt in die Datenbank; ohne Schlüssel wird nichts geschrieben (fail-closed). */
export function sealTotp(secret: string, environment: NodeJS.ProcessEnv = process.env): string {
  const sealed = encryptSecret(secret, environment);
  if (!isEncrypted(sealed)) throw new TotpKeyMissingError();
  return sealed;
}

/** Liest einen gespeicherten TOTP-Schlüssel. Klartext gibt es nach dem Start nicht mehr; er gilt als Fehler. */
export function openTotp(
  stored: string | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!stored) return null;
  if (!isEncrypted(stored)) throw new Error('Zwei-Faktor-Schlüssel liegt unverschlüsselt vor.');
  return decryptSecret(stored, environment);
}

/**
 * Beim Start: TOTP-Schlüssel aus der Zeit vor der Verschlüsselung (Benutzer und Systemadministrator, aktiv und
 * ausstehend) werden einmal verschlüsselt neu geschrieben; vorhandene müssen sich mit dem Schlüssel lesen lassen.
 * Gibt es gespeicherte Schlüssel, aber keinen DEV_LOG_SECRET_KEY, startet der Dienst nicht. Gibt die Zahl der neu
 * verschlüsselten Werte zurück.
 */
export async function sealStoredTotpSecrets(pool: Pool, environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  const stored = [
    ...(
      await pool.query<{ id: string; pending: boolean; value: string }>(
        `SELECT id::text, FALSE AS pending, totp_secret AS value FROM users WHERE totp_secret IS NOT NULL
         UNION ALL
         SELECT id::text, TRUE AS pending, totp_pending AS value FROM users WHERE totp_pending IS NOT NULL`,
      )
    ).rows.map((row) => ({ ...row, column: row.pending ? ('totp_pending' as const) : ('totp_secret' as const) })),
    ...(
      await pool.query<{ id: string; value: string }>(
        'SELECT key AS id, value FROM app_settings WHERE key IN ($1, $2)',
        [TOTP_KEY, TOTP_PENDING_KEY],
      )
    ).rows.map((row) => ({ ...row, column: null })),
  ];
  if (!stored.length) return 0;
  if (!environment.DEV_LOG_SECRET_KEY?.trim()) throw new TotpKeyMissingError();
  let sealed = 0;
  for (const row of stored) {
    if (isEncrypted(row.value)) {
      try {
        decryptSecret(row.value, environment);
      } catch {
        throw new Error('Zwei-Faktor-Schlüssel lassen sich mit dem gesetzten DEV_LOG_SECRET_KEY nicht lesen.');
      }
      continue;
    }
    const value = sealTotp(row.value, environment);
    // Nur ersetzen, was noch der gelesene Klartext ist (ein gleichzeitiger Start hat es sonst schon erledigt).
    if (row.column) {
      await pool.query(`UPDATE users SET ${row.column} = $2 WHERE id = $1 AND ${row.column} = $3`, [
        row.id,
        value,
        row.value,
      ]);
    } else {
      await pool.query('UPDATE app_settings SET value = $2 WHERE key = $1 AND value = $3', [row.id, value, row.value]);
    }
    sealed += 1;
  }
  return sealed;
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
  return openTotp(result?.rows[0]?.value);
}

/** Zwischenspeicher für die Bindung des Systemadministrators – scrypt läuft so nur einmal je Passwort. */
let adminVersion: { id: string; value: Promise<string> } | null = null;

/**
 * Bindung einer Sitzung an die Zugangsdaten. Benutzer: abgeleitet vom Passwort-Hash (neues Passwort = neuer Salt =
 * neue Version). Systemadministrator: abgeleitet von Name und Passwort aus der .env, per scrypt, damit aus der
 * Datenbank allein das Passwort nicht schnell zu erraten ist. Wird das Passwort rotiert, passt keine alte Sitzung mehr.
 */
export async function credentialVersion(auth: DevLogAuth, passwordHash: string | null): Promise<string> {
  if (passwordHash !== null) return `u1:${createHash('sha256').update(passwordHash).digest('hex')}`;
  const id = `${auth.username}\0${auth.password}`;
  if (adminVersion?.id !== id) {
    adminVersion = {
      id,
      value: scrypt(id, Buffer.from('dev-log/session-binding'), 32).then((hash) => `s1:${hash.toString('hex')}`),
    };
  }
  return adminVersion.value;
}

/**
 * Löscht abgelaufene Sitzungen, Sitzungen ohne Bindung und Sitzungen des Systemadministrators mit einer alten
 * Bindung (Passwort in der .env rotiert). Aktive, gültige Sitzungen bleiben. Gibt die Zahl der gelöschten zurück.
 */
export async function purgeSessions(pool: Pool, auth: DevLogAuth | null): Promise<number> {
  const result = await pool.query(
    `DELETE FROM auth_sessions
      WHERE expires_at <= NOW() OR credential_version IS NULL
         OR (user_id IS NULL AND credential_version IS DISTINCT FROM $1)`,
    [auth ? await credentialVersion(auth, null) : null],
  );
  return result.rowCount ?? 0;
}

/** Startet die stündliche Sitzungs-Bereinigung (erster Lauf sofort, blockiert den Start nicht); gibt den Stopp zurück. */
export function startSessionCleanup(pool: Pool, auth: DevLogAuth | null, intervalMs = SESSION_CLEANUP_MS): () => void {
  const run = (): void => void purgeSessions(pool, auth).catch(logged('auth'));
  const first = setImmediate(run);
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => {
    clearImmediate(first);
    clearInterval(timer);
  };
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
 * Schlüssel für die Fehlversuch-Sperre: Konto und Herkunft. Hinter Docker Desktop erscheinen alle Zugriffe von aussen
 * mit derselben IP – eine Sperre nur nach IP träfe dann alle Geräte gleichzeitig. Die echte Client-IP kommt über
 * X-Forwarded-For, aber nur von Proxys aus DEV_LOG_TRUST_PROXY (siehe app.ts).
 */
function attemptKey(source: string, username: unknown): string {
  const name = typeof username === 'string' ? username.trim().toLowerCase().slice(0, 80) : '';
  return `${source}|${name}`;
}

/** 429 mit Wartezeit (Retry-After in Sekunden, Meldung in ganzen Minuten). */
function tooManyAttempts(response: Response, waitMs: number): void {
  const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
  response.set('Retry-After', String(Math.max(1, Math.ceil(waitMs / 1000))));
  response.status(429).json({
    message: `Zu viele Fehlversuche. Bitte in ${minutes === 1 ? 'einer Minute' : `${minutes} Minuten`} erneut versuchen.`,
  });
}

/** Angemeldeter Benutzer zur Sitzung (null = ungültig, abgelaufen oder Benutzer deaktiviert). */
async function sessionPrincipal(pool: Pool, auth: DevLogAuth, token: string): Promise<Principal | null> {
  const result = await pool.query<{
    last_seen: Date;
    user_id: string | null;
    credential_version: string | null;
    password_hash: string | null;
    username: string | null;
    display_name: string | null;
    roles: string[] | null;
    active: boolean | null;
  }>(
    `SELECT s.last_seen, s.user_id, s.credential_version, u.password_hash, u.username, u.display_name, u.roles, u.active
       FROM auth_sessions s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [hashToken(token)],
  );
  const session = result.rows[0];
  if (!session) return null;
  if (session.user_id && (!session.active || !session.password_hash)) return null;
  // Ohne Bindung oder mit alter Bindung (Passwort geändert) gilt die Sitzung nicht – auch für den .env-Admin.
  const expected = await credentialVersion(auth, session.user_id ? (session.password_hash ?? '') : null);
  if (!session.credential_version || !equalSecret(session.credential_version, expected)) return null;
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
 * Erneute Prüfung für lange offene Verbindungen (Chat-Stream): Sitzung noch gültig (kein Logout, nicht abgelaufen,
 * gebunden), Benutzer aktiv und das Projekt weiterhin freigegeben (Administrator oder Mitglied). Alte Bindungen
 * verschwinden ganz: Ein neues Benutzerpasswort löscht die Sitzungen, ein neues .env-Passwort purgeSessions beim Start.
 */
export async function sessionStillAllowed(pool: Pool, token: string, project: string): Promise<boolean> {
  const session = (
    await pool.query<{ user_id: string | null; active: boolean | null; roles: string[] | null; member: boolean }>(
      `SELECT s.user_id, u.active, u.roles,
              EXISTS (SELECT 1 FROM project_members m WHERE m.user_id = s.user_id AND m.project_slug = $2) AS member
         FROM auth_sessions s LEFT JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > NOW() AND s.credential_version IS NOT NULL`,
      [hashToken(token), project],
    )
  ).rows[0];
  if (!session) return false;
  if (!session.user_id) return true; // Systemadministrator aus der .env
  return Boolean(session.active) && (roleList(session.roles).includes('admin') || session.member);
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
        // Für lange offene Verbindungen (Chat-Stream), die die Sitzung später erneut prüfen.
        response.locals.sessionToken = token;
        next();
        return;
      }
      const basic = basicCredentials(request.get('authorization'));
      // Basic Auth (nur für Skripte) gilt nur ohne zweiten Faktor. Mit zweitem Faktor wird ein mitgeschickter
      // Header ignoriert statt gezählt: Browser senden alte, zwischengespeicherte Zugangsdaten bei jeder Anfrage
      // automatisch mit – das würde sonst sofort das Konto sperren. Eigener Schlüssel, damit die Login-Seite frei bleibt.
      if (basic && !auth.totpSecret) {
        const source = clientSource(request.ip);
        const client = `basic|${attemptKey(source, basic[0])}`;
        const wait = limiter.retryAfter(client, source);
        if (wait > 0) {
          tooManyAttempts(response, wait);
          return;
        }
        if (equalSecret(basic[0], auth.username) && equalSecret(basic[1], auth.password)) {
          limiter.reset(client);
          response.locals.principal = systemAdmin(auth);
          next();
          return;
        }
        limiter.recordFailure(client, Date.now(), source);
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
  /** Bindung für die neue Sitzung (siehe credentialVersion) */
  credentialVersion: string;
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
    // Das .env-Passwort wird direkt verglichen; der scrypt-Lauf sorgt dafür, dass der Name des Systemadministrators
    // nicht an einer schnelleren Antwort zu erkennen ist.
    await dummyVerify(password);
    return equalSecret(password, auth.password)
      ? {
          principal: systemAdmin(auth),
          key: 'system',
          totpSecret: auth.totpSecret ?? null,
          credentialVersion: await credentialVersion(auth, null),
        }
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
    await dummyVerify(password);
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
    totpSecret: openTotp(user.totp_secret),
    credentialVersion: await credentialVersion(auth, user.password_hash),
  };
}

/** Öffentliche Anmelde-Routen; vor requireCredentials registrieren. */
export function registerLoginRoutes(app: Router, pool: Pool, auth: DevLogAuth, limiter: FailureLimiter): void {
  app.get('/session', access({ tenant: 'global' }), async (request, response, next) => {
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

  app.post('/login', access({ role: null, tenant: 'global' }), async (request, response, next) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      // Vor dem scrypt-Lauf prüfen: Gebremste Anfragen kosten so weder CPU noch einen neuen Eintrag.
      const source = clientSource(request.ip);
      const client = attemptKey(source, body.username);
      const wait = limiter.retryAfter(client, source);
      if (wait > 0) {
        tooManyAttempts(response, wait);
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
        limiter.recordFailure(client, Date.now(), source);
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
        `INSERT INTO auth_sessions (token_hash, expires_at, user_agent, user_id, credential_version)
         VALUES ($1, NOW() + make_interval(days => $2), $3, $4, $5)`,
        [
          hashToken(token),
          SESSION_DAYS,
          (request.get('user-agent') ?? '').slice(0, 300),
          account.principal.id,
          account.credentialVersion,
        ],
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

  app.post('/logout', access({ role: null, tenant: 'global' }), async (request, response, next) => {
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
export function registerSecurityRoutes(
  app: Router,
  pool: Pool,
  auth: DevLogAuth,
  limiter = new FailureLimiter(),
): void {
  const principalOf = (response: Response): Principal => response.locals.principal as Principal;
  const totpOf = async (principal: Principal): Promise<string | null> =>
    principal.id
      ? openTotp(
          (
            await pool.query<{ secret: string | null }>('SELECT totp_secret AS secret FROM users WHERE id = $1', [
              principal.id,
            ])
          ).rows[0]?.secret,
        )
      : (auth.totpSecret ?? null);

  /**
   * Einen Schlüssel einrichten, ersetzen oder abschalten verlangt das aktuelle Passwort und – ist der zweite Faktor
   * schon aktiv – einen gültigen Code des bisherigen Schlüssels. Ein gestohlenes Sitzungs-Cookie allein reicht so
   * nicht, um den Besitzer mit einem eigenen Schlüssel auszusperren. Antwortet selbst und gibt false zurück, wenn etwas
   * fehlt. Ein fehlender Code wird vor der Passwortprüfung gemeldet; ist etwas falsch, sagt die Antwort nicht, was.
   * consumeCode: Beim Einrichten gilt der Code nur einmal; beim Bestätigen kurz danach darf derselbe Code noch einmal
   * kommen, sonst müsste man auf den nächsten Code der App warten.
   */
  const confirmIdentity = async (
    principal: Principal,
    body: unknown,
    response: Response,
    consumeCode: boolean,
  ): Promise<boolean> => {
    const { password, currentCode } = (body ?? {}) as { password?: unknown; currentCode?: unknown };
    const key = `totp|${principal.id ?? 'system'}`;
    const wait = limiter.retryAfter(key);
    if (wait > 0) {
      tooManyAttempts(response, wait);
      return false;
    }
    const secret = await totpOf(principal);
    if (secret && (typeof currentCode !== 'string' || !currentCode.trim())) {
      response.status(400).json({
        message: 'Bitte das Passwort und den aktuellen Code aus der Authenticator-App eingeben.',
        field: 'currentCode',
      });
      return false;
    }
    let passwordOk = false;
    if (typeof password === 'string') {
      if (principal.id) {
        const stored = (
          await pool.query<{ hash: string }>('SELECT password_hash AS hash FROM users WHERE id = $1', [principal.id])
        ).rows[0]?.hash;
        passwordOk = Boolean(stored) && (await verifyPassword(password, stored ?? ''));
      } else {
        await dummyVerify(password);
        passwordOk = equalSecret(password, auth.password);
      }
    }
    // Der Code wird nur bei richtigem Passwort geprüft (und verbraucht); die Antwort ist in beiden Fällen gleich.
    const codeOk =
      passwordOk &&
      (!secret ||
        (consumeCode
          ? acceptCode(principal.id ?? 'system', secret, currentCode)
          : typeof currentCode === 'string' && verifyTotp(secret, currentCode) !== null));
    if (!codeOk) {
      limiter.recordFailure(key);
      response.status(400).json({
        message: secret ? 'Passwort oder Code stimmen nicht.' : 'Das Passwort stimmt nicht.',
        field: 'password',
      });
      return false;
    }
    limiter.reset(key);
    return true;
  };

  app.get('/auth/status', access({ tenant: 'global' }), async (request, response, next) => {
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

  app.post('/auth/totp/setup', access({ role: null, tenant: 'global' }), async (request, response, next) => {
    try {
      const principal = principalOf(response);
      if (!process.env.DEV_LOG_SECRET_KEY?.trim()) {
        // Ohne Schlüssel kein verschlüsseltes Speichern – dann lieber gar keinen zweiten Faktor einrichten.
        response
          .status(503)
          .json({ message: 'Zwei-Faktor lässt sich gerade nicht einrichten. Bitte die Administration informieren.' });
        return;
      }
      if (!(await confirmIdentity(principal, request.body, response, true))) return;
      const secret = generateSecret();
      if (principal.id) {
        await pool.query('UPDATE users SET totp_pending = $2 WHERE id = $1', [principal.id, sealTotp(secret)]);
      } else {
        await pool.query(
          `INSERT INTO app_settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [TOTP_PENDING_KEY, sealTotp(secret)],
        );
      }
      const uri = otpauthUri(secret, principal.username);
      const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240, color: { dark: '#202824', light: '#ffffff' } });
      response.json({ secret, uri, qr });
    } catch (error) {
      next(error);
    }
  });

  app.post('/auth/totp/enable', access({ role: null, tenant: 'global' }), async (request, response, next) => {
    try {
      const principal = principalOf(response);
      if (!(await confirmIdentity(principal, request.body, response, false))) return;
      const pending = openTotp(
        principal.id
          ? (
              await pool.query<{ value: string | null }>('SELECT totp_pending AS value FROM users WHERE id = $1', [
                principal.id,
              ])
            ).rows[0]?.value
          : (await pool.query<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', [TOTP_PENDING_KEY]))
              .rows[0]?.value,
      );
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
          [TOTP_KEY, sealTotp(pending)],
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

  app.post('/auth/totp/disable', access({ role: null, tenant: 'global' }), async (request, response, next) => {
    try {
      const principal = principalOf(response);
      if (!(await totpOf(principal))) {
        response.status(400).json({ message: 'Die Zwei-Faktor-Anmeldung ist nicht aktiv.' });
        return;
      }
      // Wie beim Einrichten: Passwort und aktueller Code, sonst sperrt ein gestohlenes Cookie den Besitzer aus.
      if (!(await confirmIdentity(principal, request.body, response, true))) return;
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

  app.post('/auth/logout-others', access({ role: null, tenant: 'global' }), async (request, response, next) => {
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
