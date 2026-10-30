import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import type { Principal } from './roles.js';
import { serveRoutes } from './serve-routes.test.js';
import { registerTestRunRoutes } from './test-runs.js';
import { withMigratedDatabase } from '../db/test-database.test.js';

const admin: Principal = { id: null, username: 'admin', displayName: 'Admin', roles: ['admin'] };

test('Testläufe auf PostgreSQL: Übersicht, Live-Ansicht, Einzeltests, Medien mit Range', async (t) => {
  await withMigratedDatabase(t, 'devlog_test_runs', async (db) => {
    const pool = db as unknown as Pool;
    await pool.query(
      `INSERT INTO projects (slug, name, repository) VALUES ('alpha', 'Alpha', '/tmp/a'), ('beta', 'Beta', '/tmp/b')`,
    );
    const run = async (slug: string, status: string, startedAt: string) =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO test_runs (id, project_slug, status, trigger, started_at)
           VALUES (gen_random_uuid(), $1, $2, 'manual', $3) RETURNING id`,
          [slug, status, startedAt],
        )
      ).rows[0]!.id;
    const old = await run('alpha', 'passed', '2026-10-20T10:00:00Z');
    const live = await run('alpha', 'running', '2026-10-22T10:00:00Z');
    const foreign = await run('beta', 'failed', '2026-10-21T10:00:00Z');
    await pool.query(
      `INSERT INTO test_run_steps (run_id, position, command, status, category, output) VALUES
         ($1, 0, 'npm run lint', 'passed', NULL, 'ok'),
         ($1, 1, 'npm test', 'passed', 'unit', 'ok'),
         ($2, 0, 'npm test', 'passed', 'unit', 'fertig'),
         ($2, 1, 'npm run test:e2e', 'running', 'e2e', $3)`,
      [old, live, `${'a'.repeat(3000)}ENDE`],
    );
    const cases = (
      await pool.query<{ id: string }>(
        `INSERT INTO test_cases (run_id, position, category, title, status) VALUES
           ($1, 0, 'unit', 'eins', 'passed'), ($1, 1, 'unit', 'zwei', 'passed'), ($1, 2, 'e2e', 'drei', 'failed'),
           ($2, 0, 'unit', 'fremd', 'passed')
         RETURNING id`,
        [old, foreign],
      )
    ).rows;
    const video = Buffer.from('0123456789');
    const media = (
      await pool.query<{ id: string }>(
        `INSERT INTO test_media (run_id, case_id, name, mime, size, data) VALUES ($1, $2, 'video.webm', 'video/webm', 10, $3)
         RETURNING id`,
        [old, cases[2]!.id, video],
      )
    ).rows[0]!.id;
    const api = await serveRoutes(admin, (router) => registerTestRunRoutes(router, pool));
    try {
      await t.test('Übersicht: nur Läufe des Projekts, neueste zuerst, mit Zählung und Kategorie', async () => {
        const response = await api.call('GET', '/projects/alpha/test-runs');
        assert.equal(response.status, 200);
        const runs = response.body.runs;
        assert.deepEqual(
          runs.map((entry: { id: string }) => entry.id),
          [live, old],
        );
        const first = runs[1];
        assert.deepEqual(first.summary, { unit: { passed: 2 }, e2e: { failed: 1 } });
        assert.equal(first.mediaCount, 1);
        assert.deepEqual(
          first.steps.map((step: { command: string; category: string }) => [step.command, step.category]),
          [
            ['npm run lint', 'quality'],
            ['npm test', 'unit'],
          ],
          'fehlende Kategorie wird aus dem Befehl abgeleitet',
        );
        assert.equal((await api.call('GET', '/projects/UNGÜLTIG/test-runs')).status, 400);
      });

      await t.test('Live: laufender Lauf mit dem Ende der Ausgabe, sonst null, nie gecacht', async () => {
        const response = await api.call('GET', '/projects/alpha/test-runs/live');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.body.run.id, live);
        const [done, running] = response.body.run.steps;
        assert.equal(done.output, '', 'abgeschlossene Schritte ohne Ausgabe');
        assert.equal(running.output.length, 2000);
        assert.ok(running.output.endsWith('ENDE'));
        assert.deepEqual((await api.call('GET', '/projects/beta/test-runs/live')).body, { run: null });
      });

      await t.test('Einzeltests: nur aus dem eigenen Projekt, mit Medien ohne Inhalt', async () => {
        const response = await api.call('GET', `/projects/alpha/test-runs/${old}/cases`);
        assert.deepEqual(
          response.body.cases.map((entry: { title: string }) => entry.title),
          ['eins', 'zwei', 'drei'],
        );
        assert.deepEqual(response.body.cases[2].media, [
          { id: media, name: 'video.webm', mime: 'video/webm', size: 10 },
        ]);
        const crossed = await api.call('GET', `/projects/alpha/test-runs/${foreign}/cases`);
        assert.equal(crossed.status, 404, 'Lauf aus anderem Projekt: nicht gefunden');
        assert.equal(crossed.body.cases, undefined);
        assert.equal((await api.call('GET', '/projects/alpha/test-runs/keine-uuid/cases')).status, 400);
      });

      await t.test('Medien: sichere Header und Byte-Bereiche für Videos', async () => {
        const full = await api.call('GET', `/test-media/${media}`);
        assert.equal(full.status, 200);
        assert.deepEqual(full.raw, video);
        assert.equal(full.headers.get('content-type'), 'video/webm');
        assert.equal(full.headers.get('content-security-policy'), "default-src 'none'");
        assert.equal(full.headers.get('x-content-type-options'), 'nosniff');

        const range = async (value: string) => api.call('GET', `/test-media/${media}`, undefined, { Range: value });
        const middle = await range('bytes=2-5');
        assert.equal(middle.status, 206);
        assert.equal(middle.headers.get('content-range'), 'bytes 2-5/10');
        assert.equal(middle.raw.toString(), '2345');
        assert.equal((await range('bytes=7-')).raw.toString(), '789');
        assert.equal((await range('bytes=-3')).raw.toString(), '789', 'die letzten drei Bytes');
        assert.equal((await range('bytes=8-99')).raw.toString(), '89', 'Ende wird begrenzt');
        const outside = await range('bytes=10-');
        assert.equal(outside.status, 416);
        assert.equal(outside.headers.get('content-range'), 'bytes */10');
        assert.equal((await range('bytes=5-2')).status, 416);
        assert.equal((await range('zeilen=1-2')).status, 200, 'unbekannte Einheit: ganze Datei');

        assert.equal((await api.call('GET', '/test-media/keine-uuid')).status, 404);
        assert.equal((await api.call('GET', '/test-media/11111111-1111-4111-8111-111111111111')).status, 404);
      });
    } finally {
      await api.close();
    }
  });
});
