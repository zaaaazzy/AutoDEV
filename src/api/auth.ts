import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import QRCode from 'qrcode';
import { FailureLimiter } from './security.js';
import { currentStep, generateSecret, otpauthUri, verifyTotp } from './totp.js';

export interface DevLogAuth {
  username: string;
  password: string;
  /** Aktiver TOTP-Schlüssel; solange er fehlt, genügt das Passwort. Beim Start aus der Datenbank geladen. */
  totpSecret?: string | null;
  /** Zuletzt verwendeter Zeitschritt – derselbe Code gilt nur einmal. */
  lastTotpStep?: number;
}

export const SESSION_COOKIE = 'devlog_session';
const SESSION_DAYS = 30;
const TOTP_KEY = 'auth_totp_secret';
const TOTP_PENDING_KEY = 'auth_totp_pending';

function equalSecret(received: string, expected: string): boolean {
  const actualBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function validPassword(username: unknown, password: unknown, auth: DevLogAuth): boolean {
  return (
    typeof username === 'string' &&
    typeof password === 'string' &&
    equalSecret(username, auth.username) &&
    equalSecret(password, auth.password)
  );
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

/** Lädt den aktiven TOTP-Schlüssel (fehlt die Tabelle noch, gilt: kein zweiter Faktor). */
export async function loadTotpSecret(pool: Pool): Promise<string | null> {
  const result = await pool
    .query<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', [TOTP_KEY])
    .catch(() => null);
  return result?.rows[0]?.value ?? null;
}

/** Prüft einen TOTP-Code und verhindert, dass derselbe Code zweimal angenommen wird. */
function acceptCode(auth: DevLogAuth, secret: string, code: unknown): boolean {
  if (typeof code !== 'string') return false;
  const step = verifyTotp(secret, code);
  if (step === null || step <= (auth.lastTotpStep ?? -1)) return false;
  auth.lastTotpStep = step;
  return true;
}

async function validSession(pool: Pool, token: string): Promise<boolean> {
  const result = await pool.query<{ last_seen: Date }>(
    'SELECT last_seen FROM auth_sessions WHERE token_hash = $1 AND expires_at > NOW()',
    [hashToken(token)],
  );
  const session = result.rows[0];
  if (!session) return false;
  if (Date.now() - new Date(session.last_seen).getTime() > 10 * 60 * 1000) {
    await pool.query('UPDATE auth_sessions SET last_seen = NOW() WHERE token_hash = $1', [hashToken(token)]);
  }
  return true;
}

/**
 * Anmeldung: Sitzungs-Cookie aus der Login-Seite. Basic Auth (für Skripte) gilt nur, solange kein zweiter Faktor
 * eingerichtet ist – sonst ließe sich der zweite Faktor damit umgehen. Oberfläche und Dateien bleiben öffentlich,
 * geschützt ist die API.
 */
export function requireCredentials(auth: DevLogAuth, pool: Pool, limiter = new FailureLimiter()): RequestHandler {
  return async (request, response, next) => {
    if (!request.path.startsWith('/api/')) {
      next();
      return;
    }
    response.set('Cache-Control', 'no-store');
    const client = request.ip ?? 'unknown';
    if (limiter.isBlocked(client)) {
      response.status(429).json({ message: 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.' });
      return;
    }
    try {
      const token = sessionToken(request);
      if (token && (await validSession(pool, token))) {
        next();
        return;
      }
      const basic = basicCredentials(request.get('authorization'));
      if (basic && !auth.totpSecret && validPassword(basic[0], basic[1], auth)) {
        limiter.reset(client);
        next();
        return;
      }
      if (basic) limiter.recordFailure(client);
      response.status(401).json({ message: 'Anmeldung erforderlich.' });
    } catch (error) {
      next(error);
    }
  };
}

/** Öffentliche Anmelde-Routen; vor requireCredentials registrieren. */
export function registerLoginRoutes(app: Express, pool: Pool, auth: DevLogAuth, limiter: FailureLimiter): void {
  app.get('/api/session', async (request, response, next) => {
    try {
      const token = sessionToken(request);
      const authenticated = Boolean(token && (await validSession(pool, token)));
      response.set('Cache-Control', 'no-store');
      response.json({ authenticated, authRequired: true, totp: Boolean(auth.totpSecret) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/login', async (request, response, next) => {
    try {
      const client = request.ip ?? 'unknown';
      if (limiter.isBlocked(client)) {
        response.status(429).json({ message: 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.' });
        return;
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const passwordOk = validPassword(body.username, body.password, auth);
      const codeOk = !auth.totpSecret || (passwordOk && acceptCode(auth, auth.totpSecret, body.code));
      if (!passwordOk || !codeOk) {
        limiter.recordFailure(client);
        const message =
          passwordOk && auth.totpSecret
            ? 'Der Code aus der Authenticator-App stimmt nicht.'
            : 'Benutzername oder Passwort stimmen nicht.';
        response.status(401).json({ message, totp: Boolean(auth.totpSecret) });
        return;
      }
      limiter.reset(client);
      const token = randomBytes(32).toString('base64url');
      await pool.query(
        `INSERT INTO auth_sessions (token_hash, expires_at, user_agent)
         VALUES ($1, NOW() + make_interval(days => $2), $3)`,
        [hashToken(token), SESSION_DAYS, (request.get('user-agent') ?? '').slice(0, 300)],
      );
      setSessionCookie(request, response, token, SESSION_DAYS * 24 * 3600);
      response.json({ authenticated: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/logout', async (request, response, next) => {
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

/** Einrichten und Abschalten des zweiten Faktors sowie Abmelden anderer Geräte (nur angemeldet). */
export function registerSecurityRoutes(app: Express, pool: Pool, auth: DevLogAuth): void {
  app.get('/api/auth/status', async (request, response, next) => {
    try {
      const sessions = await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM auth_sessions WHERE expires_at > NOW()',
      );
      response.json({
        totp: Boolean(auth.totpSecret),
        sessions: Number(sessions.rows[0]?.count ?? 0),
        sessionLogin: Boolean(sessionToken(request)),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/totp/setup', async (_request, response, next) => {
    try {
      const secret = generateSecret();
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [TOTP_PENDING_KEY, secret],
      );
      const uri = otpauthUri(secret, auth.username);
      const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240, color: { dark: '#202824', light: '#ffffff' } });
      response.json({ secret, uri, qr });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/totp/enable', async (request, response, next) => {
    try {
      const pending = (
        await pool.query<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', [TOTP_PENDING_KEY])
      ).rows[0]?.value;
      const code = (request.body as { code?: unknown } | undefined)?.code;
      if (!pending || typeof code !== 'string' || verifyTotp(pending, code) === null) {
        response.status(400).json({ message: 'Der Code stimmt nicht. Bitte den aktuellen Code aus der App eingeben.' });
        return;
      }
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [TOTP_KEY, pending],
      );
      await pool.query('DELETE FROM app_settings WHERE key = $1', [TOTP_PENDING_KEY]);
      auth.totpSecret = pending;
      auth.lastTotpStep = currentStep();
      // Sitzungen, die nur mit Passwort entstanden sind, gelten nicht mehr – außer der aktuellen.
      const token = sessionToken(request);
      await pool.query('DELETE FROM auth_sessions WHERE token_hash <> $1', [token ? hashToken(token) : '']);
      response.json({ totp: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/totp/disable', async (request, response, next) => {
    try {
      const code = (request.body as { code?: unknown } | undefined)?.code;
      if (!auth.totpSecret || !acceptCode(auth, auth.totpSecret, code)) {
        response.status(400).json({ message: 'Der Code stimmt nicht.' });
        return;
      }
      await pool.query('DELETE FROM app_settings WHERE key = $1', [TOTP_KEY]);
      auth.totpSecret = null;
      response.json({ totp: false });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/logout-others', async (request, response, next) => {
    try {
      const token = sessionToken(request);
      const result = await pool.query('DELETE FROM auth_sessions WHERE token_hash <> $1', [
        token ? hashToken(token) : '',
      ]);
      response.json({ removed: result.rowCount ?? 0 });
    } catch (error) {
      next(error);
    }
  });
}
