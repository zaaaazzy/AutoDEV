import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { saveEvidence } from '../runner/acceptance.js';
import { withMigratedDatabase } from '../db/test-database.test.js';
import type { Principal } from './roles.js';
import { requiredRole } from './route-table.test.js';
import { serveRoutes } from './serve-routes.test.js';
import { evidenceBodyProblem, registerTestRequestRoutes } from './test-requests.js';

const admin: Principal = { id: null, username: 'admin', displayName: 'Admin', roles: ['admin'] };
const ID = '00000000-0000-4000-8000-000000000001';

test('Nachweis-Start: braucht die Rolle „run“ und nimmt keinen Befehl aus dem Request', () => {
  assert.equal(requiredRole('POST', `/api/projects/dev-log/test-evidence/${ID}/run`, {}), 'run');
  assert.equal(evidenceBodyProblem(undefined), null);
  assert.equal(evidenceBodyProblem({}), null);
  assert.equal(evidenceBodyProblem({ comment: 'bitte' }), null);
  assert.match(String(evidenceBodyProblem({ befehl: 'rm -rf /' })), /befehl/);
  assert.match(String(evidenceBodyProblem({ command: ['sh', '-c', 'x'] })), /command/);
  assert.ok(evidenceBodyProblem('npm test'));
});

test('Testnachweise auf PostgreSQL: Liste, Start nur per ID, 400/409/422 und Status', async (t) => {
  await withMigratedDatabase(t, 'devlog_evidence_routes', async (db) => {
    const pool = db as unknown as Pool;
    await pool.query(
      `INSERT INTO projects (slug, name, repository) VALUES ('alpha', 'Alpha', '/tmp/a'), ('beta', 'Beta', '/tmp/b')`,
    );
    const order = async (slug: string) =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO development_items (project_slug, title, status) VALUES ($1, 'A', 'done') RETURNING id`,
          [slug],
        )
      ).rows[0]!.id;
    const alpha = await order('alpha');
    const beta = await order('beta');
    await saveEvidence(pool, alpha, [
      { datei: 'src/a.test.ts', befehl: 'npm test -- a', grund: 'gegenprobe_fehlt' },
      { datei: 'src/b.test.ts', befehl: 'npm test -- b', grund: 'nicht_freigegeben' },
      { datei: 'src/c.test.ts', befehl: 'npx --no-install tsx --test src/c.test.ts', grund: 'gegenprobe_fehlt' },
      { datei: 'src/d.test.ts', befehl: 'npm test -- d', grund: 'gegenprobe_fehlt' },
    ]);
    await saveEvidence(pool, beta, [{ datei: 'x', befehl: 'npm test', grund: 'gegenprobe_fehlt' }]);
    await pool.query(`UPDATE test_evidence SET status = 'passed', checked_at = NOW() WHERE befehl = 'npm test -- d'`);
    const idOf = async (befehl: string) =>
      (await pool.query<{ id: string }>('SELECT id FROM test_evidence WHERE befehl = $1', [befehl])).rows[0]!.id;
    const api = await serveRoutes(admin, (router) => registerTestRequestRoutes(router, pool));
    const start = async (id: string, body?: unknown) =>
      (await api.call('POST', `/projects/alpha/test-evidence/${id}/run`, body)).status;
    try {
      const list = await api.call('GET', '/projects/alpha/test-evidence');
      assert.equal(list.status, 200);
      assert.equal(list.body.testRunning, false);
      assert.deepEqual(
        list.body.evidence.map((entry: { befehl: string; allowed: boolean; grund: string }) => [
          entry.befehl,
          entry.grund,
          entry.allowed,
        ]),
        [
          ['npm test -- a', 'gegenprobe_fehlt', true],
          ['npm test -- b', 'nicht_freigegeben', true],
          ['npx --no-install tsx --test src/c.test.ts', 'gegenprobe_fehlt', false],
        ],
        'abgehakte fehlen, fremde Projekte auch',
      );

      const allowed = await idOf('npm test -- a');
      // Befehl im Body: abgelehnt, es entsteht keine Anfrage.
      assert.equal(await start(allowed, { befehl: 'rm -rf /' }), 400);
      assert.equal(await start(allowed, { command: ['sh', '-c', 'id'] }), 400);
      assert.equal((await pool.query('SELECT 1 FROM test_requests')).rowCount, 0);
      assert.equal(await start('kein-uuid', {}), 400);
      // Nachweis eines anderen Projekts: nicht gefunden.
      assert.equal(await start(await idOf('npm test'), {}), 404);

      // Grund „nicht_freigegeben“ bzw. abgelehnter Befehl: kein Start, Verweis auf die Rechte.
      assert.equal(await start(await idOf('npm test -- b')), 422);
      const refused = await idOf('npx --no-install tsx --test src/c.test.ts');
      assert.equal(await start(refused), 422);
      const refusedRow = (await pool.query('SELECT status FROM test_evidence WHERE id = $1', [refused])).rows[0];
      assert.equal(refusedRow.status, 'nicht_freigegeben');
      assert.equal((await pool.query('SELECT 1 FROM test_requests')).rowCount, 0);
      // Schon erbracht: nicht noch einmal.
      assert.equal(await start(await idOf('npm test -- d')), 409);

      // Erlaubter Befehl: Projekttestlauf mit Umfang „befehl“ und Verweis, ohne Befehl in der Anfrage.
      const started = await api.call('POST', `/projects/alpha/test-evidence/${allowed}/run`, {});
      assert.equal(started.status, 201);
      assert.equal(started.body.request.scope, 'befehl');
      assert.equal(started.body.request.evidenceId, allowed);
      const running = await api.call('GET', '/projects/alpha/test-evidence');
      assert.equal(running.body.testRunning, true);
      assert.equal(running.body.evidence.find((entry: { id: string }) => entry.id === allowed).running, true);
      // Während ein Test läuft: 409.
      assert.equal(await start(allowed, {}), 409);

      // Kompletter Test läuft (anderer Umfang): Nachweis-Start ebenfalls 409.
      await pool.query(`UPDATE test_requests SET status = 'done'`);
      await pool.query(`INSERT INTO test_requests (project_slug, scope, status) VALUES ('alpha', 'full', 'running')`);
      assert.equal(await start(allowed, {}), 409);
    } finally {
      await api.close();
    }
  });
});
