import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import pg, { type Pool } from 'pg';
import { MIGRATIONS, runMigrations } from '../db/migrations.js';
import { isEncrypted } from '../core/secrets.js';
import { createDevLogApp } from './app.js';
import {
  credentialVersion,
  openTotp,
  purgeSessions,
  sealStoredTotpSecrets,
  sealTotp,
  sessionStillAllowed,
  startSessionCleanup,
} from './auth.js';
import { registerUserRoutes } from './users.js';
import { adminPool, databaseUrl, dropDatabase } from '../db/test-database.test.js';

delete process.env.DEV_LOG_PROJECT_ROOTS;

const KEY = { DEV_LOG_SECRET_KEY: 'ein-schluessel-nur-fuer-tests' };
const auth = { username: 'dev-log-user', password: 'a-long-enough-local-password' };

/** Sitzungen im Speicher wie in auth_sessions; die Bindung kommt aus dem INSERT des Logins. */
function sessionStore() {
  const sessions = new Map<string, string | null>();
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith('INSERT INTO auth_sessions')) sessions.set(values[0] as string, values[4] as string);
      else if (sql.includes('FROM auth_sessions s')) {
        if (!sessions.has(values[0] as string)) return { rows: [] };
        return {
          rows: [{ last_seen: new Date(), user_id: null, credential_version: sessions.get(values[0] as string) }],
        };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, sessions };
}

async function serve<T>(pool: Pool, credentials: typeof auth, action: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createDevLogApp(pool, credentials).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    return await action(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('Sitzung des .env-Admins gilt nach einer Passwortrotation nicht mehr', async () => {
  const { pool, sessions } = sessionStore();
  const cookie = await serve(pool, auth, async (baseUrl) => {
    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(auth),
    });
    assert.equal(login.status, 200);
    const value = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    assert.equal((await fetch(`${baseUrl}/api/projects`, { headers: { Cookie: value } })).status, 200);
    return value;
  });
  // Neustart mit neuem Passwort in der .env: dieselbe Sitzung ist ungültig.
  const rotated = { ...auth, password: 'ein-ganz-neues-langes-passwort' };
  await serve(pool, rotated, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/projects`, { headers: { Cookie: cookie } })).status, 401);
  });
  // Sitzungen ohne Bindung (von vor der Änderung) gelten ebenfalls nicht.
  for (const key of sessions.keys()) sessions.set(key, null);
  await serve(pool, auth, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/projects`, { headers: { Cookie: cookie } })).status, 401);
  });
});

test('Bindung: neues Benutzerpasswort und neues .env-Passwort ergeben eine neue Version', async () => {
  assert.notEqual(await credentialVersion(auth, 'scrypt$a$b'), await credentialVersion(auth, 'scrypt$c$d'));
  const admin = await credentialVersion(auth, null);
  assert.equal(await credentialVersion(auth, null), admin, 'stabil für dasselbe Passwort');
  assert.notEqual(await credentialVersion({ ...auth, password: 'ein-anderes-langes-passwort' }, null), admin);
  assert.doesNotMatch(admin, new RegExp(auth.password), 'kein Klartext');
});

test('Chat-Stream: Sitzung ohne Bindung gilt nicht mehr', async () => {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
  } as unknown as Pool;
  assert.equal(await sessionStillAllowed(pool, 'token', 'p'), false);
  assert.match(queries[0]!, /credential_version IS NOT NULL/);
});

test('Passwortwechsel eines Benutzers: Hash und Sitzungen in einer Anweisung', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return sql.includes('UPDATE users SET password_hash') ? { rows: [{ id: values[0] }], rowCount: 1 } : { rows: [] };
    },
  } as unknown as Pool;
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.principal = { id: null, username: 'admin', displayName: 'Admin', roles: ['admin'] };
    next();
  });
  const router = express.Router();
  registerUserRoutes(router, pool, null);
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const id = '11111111-1111-4111-8111-111111111111';
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/users/${id}/password`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'ein-neues-sicheres-passwort-123' }),
      },
    );
    assert.equal(response.status, 200);
    const change = queries.filter((query) => query.sql.includes('password_hash'));
    assert.equal(change.length, 1);
    assert.match(change[0]!.sql, /UPDATE users SET password_hash[\s\S]*DELETE FROM auth_sessions WHERE user_id IN/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Bereinigung: löscht nur abgelaufene, ungebundene und an ein altes .env-Passwort gebundene Sitzungen', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return { rows: [], rowCount: 2 };
    },
  } as unknown as Pool;
  assert.equal(await purgeSessions(pool, auth), 2);
  assert.match(queries[0]!.sql, /DELETE FROM auth_sessions\s+WHERE expires_at <= NOW\(\)/);
  assert.deepEqual(queries[0]!.values, [await credentialVersion(auth, null)]);

  // Der Timer läuft im Hintergrund, blockiert den Start nicht und endet mit dem Stopp.
  const stop = startSessionCleanup(pool, auth, 20);
  await new Promise((resolve) => setTimeout(resolve, 70));
  stop();
  const runs = queries.length;
  assert.ok(runs >= 3, `mindestens ein Lauf sofort und einer im Takt (${runs - 1})`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(queries.length, runs, 'nach dem Stopp kein weiterer Lauf');
});

/** Pool mit TOTP-Schlüsseln in users und app_settings; UPDATEs werden wie in PostgreSQL bedingt angewandt. */
function totpPool(
  users: { id: string; totp_secret: string | null; totp_pending: string | null }[],
  settings: Map<string, string>,
) {
  return {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('AS pending')) {
        return {
          rows: [
            ...users.filter((u) => u.totp_secret).map((u) => ({ id: u.id, pending: false, value: u.totp_secret })),
            ...users.filter((u) => u.totp_pending).map((u) => ({ id: u.id, pending: true, value: u.totp_pending })),
          ],
        };
      }
      if (sql.startsWith('SELECT key AS id, value FROM app_settings')) {
        return {
          rows: (values as string[])
            .filter((key) => settings.has(key))
            .map((key) => ({ id: key, value: settings.get(key) })),
        };
      }
      const column = /UPDATE users SET (\w+)/.exec(sql)?.[1] as 'totp_secret' | 'totp_pending' | undefined;
      if (column) {
        const user = users.find((u) => u.id === values[0] && u[column] === values[2]);
        if (user) user[column] = values[1] as string;
      } else if (sql.startsWith('UPDATE app_settings') && settings.get(values[0] as string) === values[2]) {
        settings.set(values[0] as string, values[1] as string);
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
}

test('TOTP-Schlüssel: Altdaten werden beim Start gelesen und verschlüsselt neu geschrieben', async () => {
  const users = [
    { id: 'u1', totp_secret: 'JBSWY3DPEHPK3PXP', totp_pending: 'KRSXG5CTMVRXEZLU' },
    { id: 'u2', totp_secret: sealTotp('GEZDGNBVGY3TQOJQ', KEY), totp_pending: null },
  ];
  const settings = new Map([['auth_totp_secret', 'MFRGGZDFMZTWQ2LK']]);
  const pool = totpPool(users, settings);
  assert.equal(await sealStoredTotpSecrets(pool, KEY), 3);
  const stored = [
    users[0]!.totp_secret,
    users[0]!.totp_pending,
    users[1]!.totp_secret,
    settings.get('auth_totp_secret'),
  ];
  for (const value of stored) assert.ok(value && isEncrypted(value), 'kein Klartext in der Datenbank');
  assert.equal(openTotp(users[0]!.totp_secret, KEY), 'JBSWY3DPEHPK3PXP');
  assert.equal(openTotp(users[0]!.totp_pending, KEY), 'KRSXG5CTMVRXEZLU');
  assert.equal(openTotp(settings.get('auth_totp_secret'), KEY), 'MFRGGZDFMZTWQ2LK');
  assert.equal(await sealStoredTotpSecrets(pool, KEY), 0, 'zweiter Start ändert nichts');
});

test('TOTP-Schlüssel: ohne DEV_LOG_SECRET_KEY startet der Dienst mit vorhandenen Schlüsseln nicht', async () => {
  const users = [{ id: 'u1', totp_secret: 'JBSWY3DPEHPK3PXP', totp_pending: null }];
  const pool = totpPool(users, new Map());
  await assert.rejects(sealStoredTotpSecrets(pool, {}), (error: Error) => {
    assert.match(error.message, /DEV_LOG_SECRET_KEY/);
    assert.doesNotMatch(error.message, /JBSWY3DPEHPK3PXP|u1/, 'verrät weder Schlüssel noch Konto');
    return true;
  });
  assert.equal(users[0]!.totp_secret, 'JBSWY3DPEHPK3PXP', 'nichts geschrieben');
  // Ohne gespeicherte Schlüssel braucht es keinen Schlüssel.
  assert.equal(await sealStoredTotpSecrets(totpPool([], new Map()), {}), 0);
  // Schreiben ohne Schlüssel und Lesen von Klartext sind gesperrt.
  assert.throws(() => sealTotp('JBSWY3DPEHPK3PXP', {}), /DEV_LOG_SECRET_KEY/);
  assert.throws(() => openTotp('JBSWY3DPEHPK3PXP', KEY));
  // Ein falscher Schlüssel fällt beim Start auf.
  const sealed = totpPool(
    [{ id: 'u1', totp_secret: sealTotp('JBSWY3DPEHPK3PXP', KEY), totp_pending: null }],
    new Map(),
  );
  await assert.rejects(
    sealStoredTotpSecrets(sealed, { DEV_LOG_SECRET_KEY: 'ein-ganz-anderer-schluessel' }),
    /nicht lesen/,
  );
});

// Echte PostgreSQL-Datenbank (siehe test-database.test.ts); ohne sie übersprungen.
test('Migration und Bereinigung auf PostgreSQL: Indizes, Altsitzungen weg, aktive bleiben', async (t) => {
  const admin = await adminPool(t);
  if (!admin) return;
  const name = `devlog_sessions_${process.pid}`;
  await dropDatabase(admin, name);
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ connectionString: databaseUrl(name), max: 1 });
  try {
    // Bestands-DB mit einer Sitzung von vor der Bindung.
    const before = MIGRATIONS.filter((migration) => migration.version < 7);
    await runMigrations(pool, before);
    await pool.query(`INSERT INTO auth_sessions (token_hash, expires_at) VALUES ('alt', NOW() + INTERVAL '1 day')`);
    await runMigrations(pool);
    const indexes = (await pool.query(`SELECT indexdef FROM pg_indexes WHERE tablename = 'auth_sessions'`)).rows.map(
      (row: { indexdef: string }) => row.indexdef,
    );
    assert.ok(indexes.some((index) => /\(user_id\)/.test(index)));
    assert.ok(indexes.some((index) => /\(expires_at\)/.test(index)));
    assert.equal((await pool.query(`SELECT 1 FROM auth_sessions WHERE token_hash = 'alt'`)).rowCount, 0);

    const current = await credentialVersion(auth, null);
    await pool.query(
      `INSERT INTO auth_sessions (token_hash, expires_at, credential_version) VALUES
         ('aktiv', NOW() + INTERVAL '1 day', $1),
         ('abgelaufen', NOW() - INTERVAL '1 minute', $1),
         ('altes-passwort', NOW() + INTERVAL '1 day', 's1:alt'),
         ('ungebunden', NOW() + INTERVAL '1 day', NULL)`,
      [current],
    );
    assert.equal(await purgeSessions(pool as unknown as Pool, auth), 3);
    const left = (await pool.query('SELECT token_hash FROM auth_sessions')).rows.map(
      (row: { token_hash: string }) => row.token_hash,
    );
    assert.deepEqual(left, ['aktiv']);

    // Altdaten: TOTP-Schlüssel im Klartext werden beim Start verschlüsselt neu geschrieben.
    await pool.query(
      `INSERT INTO users (username, password_hash, totp_secret, totp_pending) VALUES ('pia', 'x', 'JBSWY3DPEHPK3PXP', 'KRSXG5CTMVRXEZLU')`,
    );
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('auth_totp_secret', 'MFRGGZDFMZTWQ2LK')`);
    assert.equal(await sealStoredTotpSecrets(pool as unknown as Pool, KEY), 3);
    const plain = await pool.query(
      `SELECT 1 FROM users WHERE totp_secret NOT LIKE 'enc:v1:%' OR totp_pending NOT LIKE 'enc:v1:%'
       UNION ALL SELECT 1 FROM app_settings WHERE key = 'auth_totp_secret' AND value NOT LIKE 'enc:v1:%'`,
    );
    assert.equal(plain.rowCount, 0, 'kein Klartext-Schlüssel mehr in der Datenbank');
    const user = (await pool.query<{ totp_secret: string }>('SELECT totp_secret FROM users')).rows[0]!;
    assert.equal(openTotp(user.totp_secret, KEY), 'JBSWY3DPEHPK3PXP');
  } finally {
    await pool.end();
    await dropDatabase(admin, name);
    await admin.end();
  }
});
