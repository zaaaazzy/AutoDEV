import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { registerAcceptanceRoutes } from './acceptance.js';
import type { Principal } from './roles.js';
import { requiredRole } from './route-table.test.js';
import { serveRoutes } from './serve-routes.test.js';
import { DEFAULT_DEFINITION_OF_DONE } from '../runner/acceptance.js';
import { withMigratedDatabase } from '../db/test-database.test.js';

const admin: Principal = { id: null, username: 'admin', displayName: 'Admin', roles: ['admin'] };
const MISSING = '11111111-1111-4111-8111-111111111111';

test('Abnahme abhaken und prüfen lassen gehört zur Planung', () => {
  assert.equal(requiredRole('POST', `/api/development/${MISSING}/acceptance/check`, {}), 'plan');
  assert.equal(requiredRole('POST', `/api/development/${MISSING}/acceptance/verify`, {}), 'plan');
});

test('Abnahme auf PostgreSQL: Liste je Projekt, abhaken, wieder öffnen, prüfen lassen', async (t) => {
  await withMigratedDatabase(t, 'devlog_acceptance', async (db) => {
    const pool = db as unknown as Pool;
    await pool.query(
      `INSERT INTO projects (slug, name, repository) VALUES ('alpha', 'Alpha', '/tmp/a'), ('beta', 'Beta', '/tmp/b')`,
    );
    const order = async (slug: string) =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO development_items (project_slug, title) VALUES ($1, 'Auftrag') RETURNING id`,
          [slug],
        )
      ).rows[0]!.id;
    const alpha = await order('alpha');
    const beta = await order('beta');
    await pool.query(
      `INSERT INTO acceptance_checks (development_id, kind, position, text, status) VALUES
         ($1, 'criterion', 0, 'Login klappt', 'open'),
         ($1, 'criterion', 1, 'Fehlermeldung verständlich', 'unmet'),
         ($1, 'done', 0, 'Tests grün', 'met'),
         ($1, 'visual', 0, 'Kein Überlauf', 'checking'),
         ($2, 'criterion', 0, 'Fremd', 'open')`,
      [alpha, beta],
    );
    const status = async (kind: string, position: number) =>
      (
        await pool.query(
          'SELECT status, note FROM acceptance_checks WHERE development_id = $1 AND kind = $2 AND position = $3',
          [alpha, kind, position],
        )
      ).rows[0];
    const api = await serveRoutes(admin, (router) => registerAcceptanceRoutes(router, pool));
    try {
      await t.test('Liste: nur Punkte des Projekts, mit Standard-Definitionen', async () => {
        const response = await api.call('GET', '/projects/alpha/acceptance');
        assert.equal(response.body.checks.length, 4);
        assert.ok(response.body.checks.every((check: { developmentId: string }) => check.developmentId === alpha));
        assert.deepEqual(response.body.defaults.definitionOfDone, DEFAULT_DEFINITION_OF_DONE);
        assert.equal((await api.call('GET', '/projects/UNGÜLTIG/acceptance')).status, 400);
      });

      await t.test('abhaken: Eingaben geprüft, Notiz einmal ergänzt, wieder öffnen entfernt sie', async () => {
        for (const body of [
          { kind: 'irgendwas', position: 0, checked: true },
          { kind: 'criterion', position: '0', checked: true },
          { kind: 'criterion', position: 0, checked: 'ja' },
        ]) {
          assert.equal((await api.call('POST', `/development/${alpha}/acceptance/check`, body)).status, 400);
        }
        assert.equal(
          (
            await api.call('POST', '/development/keine-uuid/acceptance/check', {
              kind: 'criterion',
              position: 0,
              checked: true,
            })
          ).status,
          400,
        );
        const check = (position: number, checked: boolean, kind = 'criterion') =>
          api.call('POST', `/development/${alpha}/acceptance/check`, { kind, position, checked });
        assert.equal((await check(0, true)).status, 200);
        await check(0, true);
        assert.deepEqual(
          await status('criterion', 0),
          { status: 'met', note: '(von dir abgehakt)' },
          'Notiz nur einmal',
        );
        assert.equal((await check(0, false)).status, 200);
        assert.deepEqual(await status('criterion', 0), { status: 'open', note: '' });
        assert.equal((await check(9, true)).status, 404);
        assert.equal((await check(0, true, 'visual')).status, 404, 'laufende Prüfung bleibt unberührt');
        assert.equal((await status('visual', 0)).status, 'checking');
      });

      await t.test('prüfen lassen: offene Punkte oder ein einzelner, Erledigtes bleibt', async () => {
        const single = await api.call('POST', `/development/${alpha}/acceptance/verify`, {
          kind: 'criterion',
          position: 1,
        });
        assert.deepEqual(single.body, { queued: 1 });
        assert.equal((await status('criterion', 1)).status, 'verifying');
        assert.equal((await status('criterion', 0)).status, 'open');

        const all = await api.call('POST', `/development/${alpha}/acceptance/verify`, {});
        assert.deepEqual(all.body, { queued: 1 }, 'nur der noch offene Punkt');
        assert.equal((await status('done', 0)).status, 'met');
        assert.equal((await status('visual', 0)).status, 'checking');
        const foreign = (await pool.query('SELECT status FROM acceptance_checks WHERE development_id = $1', [beta]))
          .rows;
        assert.deepEqual(foreign, [{ status: 'open' }], 'anderer Auftrag unberührt');
        assert.equal((await api.call('POST', '/development/keine-uuid/acceptance/verify', {})).status, 404);
      });
    } finally {
      await api.close();
    }
  });
});
