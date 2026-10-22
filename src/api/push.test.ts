import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { registerPushRoutes } from './push.js';
import type { Principal } from './roles.js';
import { requiredRole } from './route-table.test.js';
import { serveRoutes } from './serve-routes.test.js';
import { withMigratedDatabase } from '../db/test-database.test.js';

const ENDPOINT = 'https://push.example.test/geraet-1';
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
    try {
      await t.test('öffentlicher Schlüssel bleibt über Aufrufe gleich, der private nie ausgeliefert', async () => {
        const first = await asAna.call('GET', '/push/key');
        const second = await asAdmin.call('GET', '/push/key');
        assert.equal(typeof first.body.publicKey, 'string');
        assert.equal(first.body.publicKey, second.body.publicKey);
        assert.deepEqual(Object.keys(first.body), ['publicKey']);
      });

      await t.test('Anmeldung wird geprüft', async () => {
        for (const body of [
          { endpoint: 'http://unsicher.test/x', keys },
          { endpoint: `https://x.test/${'a'.repeat(1000)}`, keys },
          { endpoint: ENDPOINT, keys: { p256dh: 'BKey' } },
          { endpoint: ENDPOINT },
          {},
        ]) {
          assert.equal((await asAna.call('POST', '/push/subscribe', body)).status, 400, JSON.stringify(body));
        }
        assert.equal((await pool.query('SELECT 1 FROM push_subscriptions')).rowCount, 0);
      });

      await t.test('Gerät gehört dem angemeldeten Benutzer, erneute Anmeldung übernimmt es', async () => {
        assert.deepEqual((await asAna.call('POST', '/push/subscribe', { endpoint: ENDPOINT, keys })).body, {
          subscribed: true,
        });
        assert.deepEqual(await owner(), [{ user_id: userId, system_admin: false }]);
        await asAdmin.call('POST', '/push/subscribe', { endpoint: ENDPOINT, keys: { ...keys, auth: 'Neu' } });
        assert.deepEqual(await owner(), [{ user_id: null, system_admin: true }], 'kein doppelter Eintrag');
        const row = (await pool.query('SELECT auth FROM push_subscriptions WHERE endpoint = $1', [ENDPOINT])).rows[0];
        assert.equal(row.auth, 'Neu');
      });

      await t.test('Testnachricht geht nur an eigene Geräte; Abmelden entfernt das Gerät', async () => {
        assert.deepEqual((await asAna.call('POST', '/push/test')).body, { sent: 0 }, 'Ana hat kein Gerät mehr');
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
