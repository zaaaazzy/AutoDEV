import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { verifyPassword } from './auth.js';
import type { Principal } from './roles.js';
import { requiredRole } from './route-table.test.js';
import { serveRoutes } from './serve-routes.test.js';
import { registerUserRoutes } from './users.js';
import { withMigratedDatabase } from '../db/test-database.test.js';

const PASSWORD = 'ein-sicheres-passwort-123';
const MISSING = '11111111-1111-4111-8111-111111111111';

test('Benutzerverwaltung schreibt nur mit Administration', () => {
  for (const [method, path] of [
    ['POST', '/api/users'],
    ['PATCH', `/api/users/${MISSING}`],
    ['POST', `/api/users/${MISSING}/password`],
    ['POST', `/api/users/${MISSING}/totp/reset`],
    ['DELETE', `/api/users/${MISSING}`],
  ] as const) {
    assert.equal(requiredRole(method, path, {}), 'admin', `${method} ${path}`);
  }
});

test('Benutzerverwaltung auf PostgreSQL: anlegen, ändern, Passwort, Zwei-Faktor, löschen', async (t) => {
  await withMigratedDatabase(t, 'devlog_users', async (db) => {
    const pool = db as unknown as Pool;
    await pool.query(
      `INSERT INTO projects (slug, name, repository) VALUES ('alpha', 'Alpha', '/tmp/a'), ('beta', 'Beta', '/tmp/b')`,
    );
    const adminId = (
      await pool.query<{ id: string }>(
        `INSERT INTO users (username, password_hash, roles) VALUES ('chefin', 'x', '{admin}') RETURNING id`,
      )
    ).rows[0]!.id;
    const me: Principal = { id: adminId, username: 'chefin', displayName: 'Chefin', roles: ['admin'] };
    const api = await serveRoutes(me, (router) =>
      registerUserRoutes(router, pool, { username: 'admin', password: 'geheim' }),
    );
    const sessions = async (userId: string) =>
      (await pool.query('SELECT 1 FROM auth_sessions WHERE user_id = $1', [userId])).rowCount;
    try {
      let userId = '';

      await t.test('anlegen: Eingaben werden geprüft', async () => {
        const valid = { username: 'ana.k', password: PASSWORD, roles: ['plan'], projects: ['alpha'] };
        const rejected: [Record<string, unknown>, RegExp][] = [
          [{ ...valid, username: 'ab' }, /Benutzername/],
          [{ ...valid, username: 'ana k' }, /Benutzername/],
          [{ ...valid, username: 'Admin' }, /Systemadministrator/],
          [{ ...valid, roles: ['gott'] }, /Unbekannte Rolle/],
          [{ ...valid, roles: 'admin' }, /Unbekannte Rolle/],
          [{ ...valid, password: 'zu-kurz' }, /mindestens 12/],
          [{ ...valid, password: 'x'.repeat(201) }, /zu lang/],
          [{ ...valid, projects: ['gibt-es-nicht'] }, /Unbekanntes Projekt/],
          [{ ...valid, projects: 'alpha' }, /Unbekanntes Projekt/],
        ];
        for (const [body, message] of rejected) {
          const response = await api.call('POST', '/users', body);
          assert.equal(response.status, 400, JSON.stringify(body));
          assert.match(response.body.message, message);
        }
        assert.equal((await pool.query(`SELECT 1 FROM users WHERE username <> 'chefin'`)).rowCount, 0);
      });

      await t.test('anlegen: Passwort nur als Hash, Projekte zugeordnet, Name eindeutig', async () => {
        const created = await api.call('POST', '/users', {
          username: ' ana.k ',
          displayName: ' Ana ',
          password: PASSWORD,
          roles: ['plan', 'plan', 'docs'],
          projects: ['alpha', 'alpha'],
        });
        assert.equal(created.status, 201);
        assert.equal(created.body.user.username, 'ana.k');
        assert.equal(created.body.user.displayName, 'Ana');
        assert.deepEqual(created.body.user.roles, ['plan', 'docs']);
        assert.deepEqual(created.body.user.projects, ['alpha']);
        assert.equal(created.body.user.password_hash, undefined, 'kein Hash in der Antwort');
        userId = created.body.user.id;
        const stored = (
          await pool.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [userId])
        ).rows[0]!.password_hash;
        assert.notEqual(stored, PASSWORD);
        assert.ok(await verifyPassword(PASSWORD, stored));

        const duplicate = await api.call('POST', '/users', { username: 'ANA.K', password: PASSWORD });
        assert.equal(duplicate.status, 409);
      });

      await t.test('Liste: ohne Passwort-Hash, mit Systemadministrator und Rollen', async () => {
        const list = await api.call('GET', '/users');
        assert.equal(list.status, 200);
        assert.deepEqual(
          list.body.users.map((user: { username: string }) => user.username),
          ['ana.k', 'chefin'],
        );
        assert.ok(list.body.users.every((user: Record<string, unknown>) => !('password_hash' in user)));
        assert.deepEqual(list.body.systemAdmin, { username: 'admin', totp: false });
        assert.ok(list.body.roles.some((role: { id: string }) => role.id === 'admin'));
      });

      await t.test('ändern: Rollen und Projekte, Prüfungen, kein Selbstentzug der Administration', async () => {
        const changed = await api.call('PATCH', `/users/${userId}`, { roles: ['run'], projects: ['beta'] });
        assert.equal(changed.status, 200);
        assert.deepEqual(changed.body.user.roles, ['run']);
        assert.deepEqual(changed.body.user.projects, ['beta']);
        const members = await pool.query('SELECT project_slug FROM project_members WHERE user_id = $1', [userId]);
        assert.deepEqual(members.rows, [{ project_slug: 'beta' }], 'altes Projekt entfernt');

        assert.equal((await api.call('PATCH', `/users/${userId}`, { roles: ['gott'] })).status, 400);
        assert.equal((await api.call('PATCH', `/users/${userId}`, { projects: ['gibt-es-nicht'] })).status, 400);
        assert.equal((await api.call('PATCH', '/users/keine-uuid', { roles: ['run'] })).status, 404);
        assert.equal((await api.call('PATCH', `/users/${MISSING}`, { roles: ['run'] })).status, 404);

        assert.equal((await api.call('PATCH', `/users/${adminId}`, { roles: ['plan'] })).status, 400);
        assert.equal((await api.call('PATCH', `/users/${adminId}`, { active: false })).status, 400);
        const self = await api.call('PATCH', `/users/${adminId}`, { roles: ['admin', 'plan'], displayName: 'Boss' });
        assert.equal(self.status, 200, 'eigene Rollen ergänzen bleibt erlaubt');
      });

      await t.test('deaktivieren meldet den Benutzer sofort ab', async () => {
        await pool.query(
          `INSERT INTO auth_sessions (token_hash, expires_at, user_id) VALUES ('s1', NOW() + INTERVAL '1 day', $1)`,
          [userId],
        );
        const response = await api.call('PATCH', `/users/${userId}`, { active: false });
        assert.equal(response.status, 200);
        assert.equal(response.body.user.active, false);
        assert.equal(await sessions(userId), 0);
      });

      await t.test('Passwort setzen: geprüft, gehasht, Sitzungen beendet', async () => {
        await pool.query(
          `INSERT INTO auth_sessions (token_hash, expires_at, user_id) VALUES ('s2', NOW() + INTERVAL '1 day', $1)`,
          [userId],
        );
        assert.equal((await api.call('POST', `/users/${userId}/password`, { password: 'kurz' })).status, 400);
        assert.equal(await sessions(userId), 1, 'abgelehntes Passwort beendet nichts');
        assert.equal((await api.call('POST', `/users/${MISSING}/password`, { password: PASSWORD })).status, 404);
        assert.equal((await api.call('POST', '/users/keine-uuid/password', { password: PASSWORD })).status, 404);

        const fresh = 'ein-ganz-neues-passwort-456';
        assert.equal((await api.call('POST', `/users/${userId}/password`, { password: fresh })).status, 200);
        const stored = (
          await pool.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [userId])
        ).rows[0]!.password_hash;
        assert.ok(await verifyPassword(fresh, stored));
        assert.equal(await verifyPassword(PASSWORD, stored), false);
        assert.equal(await sessions(userId), 0);
      });

      await t.test('Zwei-Faktor zurücksetzen löscht Schlüssel und offene Einrichtung', async () => {
        await pool.query(`UPDATE users SET totp_secret = 'a', totp_pending = 'b' WHERE id = $1`, [userId]);
        const response = await api.call('POST', `/users/${userId}/totp/reset`);
        assert.deepEqual(response.body, { totp: false });
        const row = (await pool.query('SELECT totp_secret, totp_pending FROM users WHERE id = $1', [userId])).rows[0];
        assert.deepEqual(row, { totp_secret: null, totp_pending: null });
      });

      await t.test('löschen: nicht sich selbst, andere samt Projektzugriff', async () => {
        assert.equal((await api.call('DELETE', `/users/${adminId}`)).status, 400);
        assert.equal((await api.call('DELETE', '/users/keine-uuid')).status, 404);
        assert.equal((await api.call('DELETE', `/users/${userId}`)).status, 204);
        assert.equal((await pool.query('SELECT 1 FROM users WHERE id = $1', [userId])).rowCount, 0);
        assert.equal((await pool.query('SELECT 1 FROM project_members WHERE user_id = $1', [userId])).rowCount, 0);
      });
    } finally {
      await api.close();
    }
  });
});
