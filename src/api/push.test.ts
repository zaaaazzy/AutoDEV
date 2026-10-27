import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test, { mock } from 'node:test';
import type { Pool } from 'pg';
import webpush from 'web-push';
import { createDevLogApp } from './app.js';
import { deleteOwnSubscription, registerPushRoutes } from './push.js';
import type { Principal } from './roles.js';
import { requiredRole } from './route-table.test.js';
import { serveRoutes } from './serve-routes.test.js';
import { withMigratedDatabase } from '../db/test-database.test.js';

delete process.env.DEV_LOG_PROJECT_ROOTS;
// VAPID-Schlüssel werden nur verschlüsselt gespeichert; dafür braucht es einen Schlüssel.
process.env.DEV_LOG_SECRET_KEY ??= 'ein-schluessel-nur-fuer-tests';

// Endpunkt eines erlaubten Push-Dienstes (Allowlist in isAllowedPushEndpoint).
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/geraet-1';
const keys = { p256dh: 'BKey', auth: 'AuthKey' };

test('Push an- und abmelden darf jeder angemeldete Benutzer', () => {
  assert.equal(requiredRole('POST', '/api/push/subscribe', {}), null);
  assert.equal(requiredRole('POST', '/api/push/unsubscribe', {}), null);
  assert.equal(requiredRole('POST', '/api/push/test', {}), null);
});

test('Push auf PostgreSQL: Schlüssel, Anmeldung je Benutzer, Abmeldung', async (t) => {
  await withMigratedDatabase(t, 'devlog_push', async (db) => {
    const pool = db as unknown as Pool;
    const userId = (
      await pool.query<{ id: string }>(`INSERT INTO users (username, password_hash) VALUES ('ana', 'x') RETURNING id`)
    ).rows[0]!.id;
    const ana: Principal = { id: userId, username: 'ana', displayName: 'Ana', roles: ['plan'] };
    const admin: Principal = { id: null, username: 'admin', displayName: 'Admin', roles: ['admin'] };
    const asAna = await serveRoutes(ana, (router) => registerPushRoutes(router, pool));
    const asAdmin = await serveRoutes(admin, (router) => registerPushRoutes(router, pool));
    const owner = async () =>
      (await pool.query('SELECT user_id, system_admin FROM push_subscriptions WHERE endpoint = $1', [ENDPOINT])).rows;
    const storedAuth = async () =>
      (await pool.query('SELECT auth FROM push_subscriptions WHERE endpoint = $1', [ENDPOINT])).rows[0]?.auth;
    try {
      await t.test('öffentlicher Schlüssel bleibt über Aufrufe gleich, der private nie ausgeliefert', async () => {
        const first = await asAna.call('GET', '/push/key');
        const second = await asAdmin.call('GET', '/push/key');
        assert.equal(typeof first.body.publicKey, 'string');
        assert.equal(first.body.publicKey, second.body.publicKey);
        assert.deepEqual(Object.keys(first.body), ['publicKey']);
        const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'push_vapid_keys'");
        assert.ok(String(rows[0]?.value).startsWith('enc:v1:'), 'privater Schlüssel liegt verschlüsselt in der Datenbank');
      });

      await t.test('Anmeldung wird geprüft', async () => {
        for (const body of [
          { endpoint: 'http://fcm.googleapis.com/fcm/send/x', keys },
          { endpoint: 'https://192.168.1.1/x', keys },
          { endpoint: `https://fcm.googleapis.com/${'a'.repeat(1000)}`, keys },
          { endpoint: ENDPOINT, keys: { p256dh: 'BKey' } },
          { endpoint: ENDPOINT },
          {},
        ]) {
          assert.equal((await asAna.call('POST', '/push/subscribe', body)).status, 400, JSON.stringify(body));
        }
        assert.equal((await pool.query('SELECT 1 FROM push_subscriptions')).rowCount, 0);
      });

      await t.test('Gerät gehört dem angemeldeten Benutzer; nur er selbst kann es erneut anmelden', async () => {
        assert.deepEqual((await asAna.call('POST', '/push/subscribe', { endpoint: ENDPOINT, keys })).body, {
          subscribed: true,
        });
        assert.deepEqual(await owner(), [{ user_id: userId, system_admin: false }]);
        // Ein anderer Besitzer übernimmt das Gerät nicht still – gleiche Antwort, Zeile unverändert.
        const takeover = { endpoint: ENDPOINT, keys: { ...keys, auth: 'Fremd' } };
        assert.deepEqual((await asAdmin.call('POST', '/push/subscribe', takeover)).body, { subscribed: true });
        assert.deepEqual(await owner(), [{ user_id: userId, system_admin: false }]);
        assert.equal(await storedAuth(), 'AuthKey');
        // Der Besitzer selbst aktualisiert seine Schlüssel ohne doppelten Eintrag.
        await asAna.call('POST', '/push/subscribe', { endpoint: ENDPOINT, keys: { ...keys, auth: 'Neu' } });
        assert.deepEqual(await owner(), [{ user_id: userId, system_admin: false }], 'kein doppelter Eintrag');
        assert.equal(await storedAuth(), 'Neu');
      });

      await t.test('Testnachricht geht nur an eigene Geräte; Abmelden entfernt nur das eigene Gerät', async () => {
        assert.deepEqual((await asAdmin.call('POST', '/push/test')).body, { sent: 0 }, 'Admin hat kein Gerät');
        assert.deepEqual((await asAdmin.call('POST', '/push/unsubscribe', { endpoint: ENDPOINT })).body, {
          subscribed: false,
        });
        assert.deepEqual(await owner(), [{ user_id: userId, system_admin: false }], 'fremdes Gerät bleibt');
        assert.deepEqual((await asAna.call('POST', '/push/unsubscribe', { endpoint: ENDPOINT })).body, {
          subscribed: false,
        });
        assert.deepEqual(await owner(), []);
        assert.equal((await asAna.call('POST', '/push/unsubscribe', {})).status, 200, 'ohne Endpoint harmlos');
      });
    } finally {
      await asAna.close();
      await asAdmin.close();
    }
  });
});

const auth = { username: 'dev-log-user', password: 'a-long-enough-local-password' };
const VAPID = webpush.generateVAPIDKeys();
const OTHER_USER = '00000000-0000-4000-8000-000000000001';
const FOREIGN = 'https://fcm.googleapis.com/fcm/send/fremd';
const OWN = 'https://updates.push.services.mozilla.com/wpush/v2/eigen';

interface Row {
  endpoint: string;
  p256dh: string;
  auth: string;
  user_id: string | null;
  system_admin: boolean;
}

/**
 * Sitzungen und push_subscriptions im Speicher, für Abläufe über die ganze App (Login, Logout). Die Besitzprüfung
 * greift nur, wenn das SQL sie enthält – wie in Postgres, wo `ON CONFLICT … DO UPDATE … WHERE` und
 * `DELETE … AND <Besitz>` fremde Zeilen unberührt lassen.
 */
function store(rows: Row[]) {
  const sessions = new Map<string, string | null>();
  const owns = (row: Row, userId: string | null) => (userId === null ? row.system_admin : row.user_id === userId);
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith('INSERT INTO auth_sessions')) sessions.set(values[0] as string, values[4] as string);
      else if (sql.includes('FROM auth_sessions s')) {
        if (!sessions.has(values[0] as string)) return { rows: [] };
        return {
          rows: [{ last_seen: new Date(), user_id: null, credential_version: sessions.get(values[0] as string) }],
        };
      } else if (sql.includes('FROM app_settings') && values[0] === 'push_vapid_keys') {
        return { rows: [{ value: JSON.stringify(VAPID) }] };
      } else if (sql.startsWith('INSERT INTO push_subscriptions')) {
        const [endpoint, p256dh, key, , userId, systemAdmin] = values as [
          string,
          string,
          string,
          string,
          string | null,
          boolean,
        ];
        const owner = { user_id: userId, system_admin: systemAdmin };
        const existing = rows.find((row) => row.endpoint === endpoint);
        const guarded = sql.includes('IS NOT DISTINCT FROM');
        if (!existing) rows.push({ endpoint, p256dh, auth: key, ...owner });
        else if (!guarded || (existing.user_id === userId && existing.system_admin === systemAdmin)) {
          Object.assign(existing, { p256dh, auth: key }, sql.includes('user_id = EXCLUDED.user_id') ? owner : {});
        }
      } else if (sql.startsWith('DELETE FROM push_subscriptions')) {
        const checked = sql.includes('THEN system_admin ELSE user_id = $2');
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          const row = rows[index]!;
          const match = Array.isArray(values[0]) ? values[0].includes(row.endpoint) : row.endpoint === values[0];
          if (match && (!checked || owns(row, values[1] as string | null))) rows.splice(index, 1);
        }
      } else if (sql.includes('FROM push_subscriptions') && sql.includes('THEN system_admin ELSE user_id = $1')) {
        return { rows: rows.filter((row) => owns(row, values[0] as string | null)) };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return pool;
}

/** POST an die API, standardmäßig mit der Sitzung des .env-Admins; `anonymous` schickt kein Cookie mit. */
type Call = (path: string, body?: unknown, anonymous?: boolean) => Promise<Response>;

async function withAdmin<T>(pool: Pool, action: (call: Call) => Promise<T>): Promise<T> {
  const server = createDevLogApp(pool, auth).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(auth),
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    return await action((path, body, anonymous) =>
      fetch(`${baseUrl}/api${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(anonymous ? {} : { Cookie: cookie }) },
        body: JSON.stringify(body ?? {}),
      }),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const foreignRow = (): Row => ({
  endpoint: FOREIGN,
  p256dh: 'opfer',
  auth: 'opfer',
  user_id: OTHER_USER,
  system_admin: false,
});

test('Push-Anmeldung: Endpunkte außerhalb der Push-Dienste werden mit allgemeiner Meldung abgelehnt', async () => {
  const rows: Row[] = [];
  await withAdmin(store(rows), async (call) => {
    const endpoints = ['https://192.168.1.1/scan', 'https://localhost/x', 'https://evil-push.apple.com.attacker.tld/'];
    for (const endpoint of endpoints) {
      const response = await call('/push/subscribe', { endpoint, keys: { p256dh: 'p', auth: 'a' } });
      assert.equal(response.status, 400);
      const { message } = (await response.json()) as { message: string };
      assert.doesNotMatch(message, /googleapis|mozilla|apple|windows/);
    }
  });
  assert.deepEqual(rows, []);
});

test('Push-Anmeldung übernimmt kein fremdes Abo und verrät nicht, ob der Endpunkt existiert', async () => {
  const rows = [foreignRow()];
  await withAdmin(store(rows), async (call) => {
    const foreign = await call('/push/subscribe', { endpoint: FOREIGN, keys: { p256dh: 'angreifer', auth: 'x' } });
    const unknown = await call('/push/subscribe', { endpoint: OWN, keys: { p256dh: 'eigen', auth: 'y' } });
    assert.equal(foreign.status, unknown.status);
    assert.deepEqual(await foreign.json(), await unknown.json());
  });
  assert.deepEqual(rows[0], foreignRow());
  assert.equal(rows.find((row) => row.endpoint === OWN)?.system_admin, true);
});

test('Push-Abmeldung löscht nur eigene Abos, mit gleicher Antwort für fremde und unbekannte', async () => {
  const rows = [foreignRow(), { endpoint: OWN, p256dh: 'p', auth: 'a', user_id: null, system_admin: true }];
  await withAdmin(store(rows), async (call) => {
    const foreign = await call('/push/unsubscribe', { endpoint: FOREIGN });
    const unknown = await call('/push/unsubscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/gibts-nicht' });
    assert.deepEqual(await foreign.json(), await unknown.json());
    await call('/push/unsubscribe', { endpoint: OWN });
  });
  assert.deepEqual(rows, [foreignRow()]);
});

test('/push/test schickt keinen Server-POST an einen ungültigen Endpunkt und löscht das Abo', async (t) => {
  const send = mock.method(webpush, 'sendNotification', async () => ({ statusCode: 201, body: '', headers: {} }));
  t.after(() => send.mock.restore());
  const rows: Row[] = [
    { endpoint: 'https://192.168.1.1/scan', p256dh: 'p', auth: 'a', user_id: null, system_admin: true },
    { endpoint: OWN, p256dh: 'p', auth: 'a', user_id: null, system_admin: true },
  ];
  await withAdmin(store(rows), async (call) => {
    assert.deepEqual(await (await call('/push/test')).json(), { sent: 1 });
  });
  assert.deepEqual(
    send.mock.calls.map((c) => (c.arguments[0] as { endpoint: string }).endpoint),
    [OWN],
  );
  assert.deepEqual(
    rows.map((row) => row.endpoint),
    [OWN],
  );
});

test('Logout löscht das eigene Abo zum mitgeschickten Endpunkt, fremde bleiben', async () => {
  const rows = [foreignRow(), { endpoint: OWN, p256dh: 'p', auth: 'a', user_id: null, system_admin: true }];
  await withAdmin(store(rows), async (call) => {
    assert.equal((await call('/logout', { endpoint: OWN })).status, 200);
  });
  await withAdmin(store(rows), async (call) => {
    assert.equal((await call('/logout', { endpoint: FOREIGN })).status, 200);
  });
  assert.deepEqual(rows, [foreignRow()]);
});

test('Logout ohne Anmeldung löscht kein Abo des Systemadministrators', async () => {
  const own = (): Row => ({ endpoint: OWN, p256dh: 'p', auth: 'a', user_id: null, system_admin: true });
  const rows = [own()];
  await withAdmin(store(rows), async (call) => {
    await call('/logout', { endpoint: OWN }, true);
    await call('/push/unsubscribe', { endpoint: OWN }, true);
  });
  assert.deepEqual(rows, [own()]);
});

test('deleteOwnSubscription fragt ohne Principal die Datenbank gar nicht erst', async () => {
  const queries: string[] = [];
  const pool = { query: async (sql: string) => (queries.push(sql), { rows: [] }) } as unknown as Pool;
  await deleteOwnSubscription(pool, undefined, OWN);
  assert.deepEqual(queries, []);
});
