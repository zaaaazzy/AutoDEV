import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import type { OrphanResult } from '../core/shutdown.js';
import { withMigratedDatabase } from '../db/test-database.test.js';
import { recoverInterruptedRuns } from './runner-cli.js';
import { closeOrphanedRuns } from './runner.js';
import { beatWorker, workerIdFor } from './worker-identity.js';

// Wiederherstellung beim Start nur für eigene oder verwaiste Läufe (Code-Review vom 21.10.2026): Ein zweiter Worker
// darf die laufenden Agents eines lebenden ersten nicht abbrechen.

interface Seeded {
  order: string;
  run: string;
  pid: number;
}

let nextPid = 70_000;

/** Auftrag „In Arbeit“ mit laufendem Lauf, laufendem Schritt (mit Prozess) und Eintrag im Prozessregister. */
async function seedRun(db: Pool, worker: string | null): Promise<Seeded> {
  const pid = (nextPid += 2);
  const order = (
    await db.query<{ id: string }>(
      `INSERT INTO development_items (project_slug, title, status) VALUES ('alpha', $1, 'in_progress') RETURNING id`,
      [`Auftrag von ${worker ?? 'Altbestand'}`],
    )
  ).rows[0]!.id;
  const run = (
    await db.query<{ id: string }>(
      `INSERT INTO agent_runs (project_slug, development_id, status, worker_id) VALUES ('alpha', $1, 'running', $2)
       RETURNING id`,
      [order, worker],
    )
  ).rows[0]!.id;
  const started = new Date('2026-10-28T08:00:00Z');
  await db.query(
    `INSERT INTO agent_run_steps (run_id, position, agent_name, phase, status, pid, pid_started_at)
     VALUES ($1, 1, 'Entwickler', 'while_task', 'running', $2, $3)`,
    [run, pid, started],
  );
  await db.query(
    `INSERT INTO agent_processes (pid, pid_started_at, command, cwd, worker_id) VALUES ($1, $2, 'claude', '/tmp', $3)`,
    [pid + 1, started, worker],
  );
  return { order, run, pid };
}

async function state(db: Pool, seeded: Seeded) {
  const row = (
    await db.query<{ order: string; run: string; step: string; interrupted: boolean; processes: number }>(
      `SELECT d.status AS order, r.status AS run, s.status AS step, s.interrupted,
              (SELECT count(*)::int FROM agent_processes p WHERE p.pid = $2) AS processes
         FROM development_items d JOIN agent_runs r ON r.development_id = d.id JOIN agent_run_steps s ON s.run_id = r.id
        WHERE r.id = $1`,
      [seeded.run, seeded.pid + 1],
    )
  ).rows[0]!;
  return row;
}

async function staleWorker(db: Pool, id: string): Promise<void> {
  await db.query(
    `INSERT INTO runner_workers (id, last_seen) VALUES ($1, NOW() - INTERVAL '10 minutes')
     ON CONFLICT (id) DO UPDATE SET last_seen = NOW() - INTERVAL '10 minutes'`,
    [id],
  );
}

function killSpy(outcome: OrphanResult = 'gone') {
  const killed: number[] = [];
  return {
    killed,
    kill: (pid: number) => {
      killed.push(pid);
      return outcome;
    },
  };
}

async function reset(db: Pool): Promise<void> {
  await db.query('DELETE FROM agent_processes');
  await db.query('DELETE FROM development_items');
  await db.query('DELETE FROM runner_workers');
  await db.query('DELETE FROM worker_heartbeats');
}

test('Wiederherstellung beim Start auf PostgreSQL: nur eigene oder verwaiste Läufe', async (t) => {
  await withMigratedDatabase(t, 'devlog_worker_recovery', async (db) => {
    await db.query(`INSERT INTO projects (slug, name, repository) VALUES ('alpha', 'Alpha', '/tmp/a')`);

    await t.test(
      'zwei Worker: B startet, die Läufe, Schritte und Prozesse des lebenden A bleiben unberührt',
      async () => {
        await reset(db);
        await beatWorker(db, 'A');
        const a = await seedRun(db, 'A');
        const spy = killSpy();
        await recoverInterruptedRuns(db, 'B', spy.kill);
        assert.deepEqual(spy.killed, [], 'kein Prozess von A beendet');
        assert.deepEqual(await state(db, a), {
          order: 'in_progress',
          run: 'running',
          step: 'running',
          interrupted: false,
          processes: 1,
        });
        // Auch das laufende Aufräumen von B lässt die Läufe des lebenden A stehen, selbst ohne Lebenszeichen im Verlauf.
        assert.equal(await closeOrphanedRuns(db as never, ['alpha'], [], 0, 'B'), 0);
        assert.equal((await state(db, a)).run, 'running');
      },
    );

    await t.test('Worker mit altem Lebenszeichen: seine Läufe werden aufgeräumt und neu eingeplant', async () => {
      await reset(db);
      await staleWorker(db, 'A');
      const a = await seedRun(db, 'A');
      const spy = killSpy();
      await recoverInterruptedRuns(db, 'B', spy.kill);
      assert.deepEqual(spy.killed.sort(), [a.pid, a.pid + 1]);
      assert.deepEqual(await state(db, a), {
        order: 'planned',
        run: 'failed',
        step: 'failed',
        interrupted: true,
        processes: 0,
      });
    });

    await t.test('Altlauf ohne Worker-ID: verwaist bei altem Projekt-Lebenszeichen, sonst unberührt', async () => {
      await reset(db);
      await db.query(
        `INSERT INTO worker_heartbeats (project_slug, last_seen) VALUES ('alpha', NOW() - INTERVAL '10 minutes')`,
      );
      const orphan = await seedRun(db, null);
      await recoverInterruptedRuns(db, 'B', killSpy().kill);
      assert.equal((await state(db, orphan)).order, 'planned');
      assert.equal((await state(db, orphan)).run, 'failed');

      await reset(db);
      await db.query(`INSERT INTO worker_heartbeats (project_slug, last_seen) VALUES ('alpha', NOW())`);
      const alive = await seedRun(db, null);
      const spy = killSpy();
      await recoverInterruptedRuns(db, 'B', spy.kill);
      assert.equal((await state(db, alive)).run, 'running', 'ein Worker älteren Stands bedient das Projekt noch');
      assert.deepEqual(spy.killed, [alive.pid + 1], 'Registereinträge ohne Worker-ID gelten als verwaist');
    });

    await t.test(
      'Neustart mit derselben Worker-ID: eigene Läufe werden aufgeräumt, auch bei frischem Lebenszeichen',
      async () => {
        await reset(db);
        await beatWorker(db, 'A');
        const own = await seedRun(db, 'A');
        const spy = killSpy();
        await recoverInterruptedRuns(db, 'A', spy.kill);
        assert.deepEqual(spy.killed.sort(), [own.pid, own.pid + 1]);
        assert.equal((await state(db, own)).order, 'planned');
        assert.equal((await state(db, own)).run, 'failed');
      },
    );

    await t.test(
      'Gegenprobe: lebt ein Altprozess womöglich noch (failed > 0), wird nichts neu eingeplant',
      async () => {
        await reset(db);
        const own = await seedRun(db, 'A');
        await recoverInterruptedRuns(db, 'A', killSpy('failed').kill);
        const after = await state(db, own);
        assert.notEqual(after.order, 'planned');
        assert.equal(after.run, 'failed');
        assert.equal(after.processes, 1, 'Eintrag bleibt für den nächsten Versuch');
      },
    );

    await t.test('langer Schritt ohne Verlaufseinträge: der gehaltene eigene Lauf wird nicht beendet', async () => {
      await reset(db);
      await beatWorker(db, 'A');
      const long = await seedRun(db, 'A');
      await db.query(`UPDATE agent_runs SET started_at = NOW() - INTERVAL '2 hours' WHERE id = $1`, [long.run]);
      await db.query(`UPDATE agent_run_steps SET started_at = NOW() - INTERVAL '2 hours' WHERE run_id = $1`, [
        long.run,
      ]);
      assert.equal(await closeOrphanedRuns(db as never, ['alpha'], [long.run], 5 * 60_000, 'A'), 0);
      assert.equal((await state(db, long)).run, 'running');
      // Gegenprobe: hält der Worker den Lauf nicht mehr (Rest eines Vorgängers), wird er beendet.
      assert.equal(await closeOrphanedRuns(db as never, ['alpha'], [], 5 * 60_000, 'A'), 1);
      assert.equal((await state(db, long)).run, 'failed');
    });
  });
});

test('workerIdFor: fest je Installation und Bereich, von Hand über DEV_LOG_WORKER_ID', () => {
  assert.equal(workerIdFor({}, '/AIdeation/source', 'alle', 'mac'), 'mac:/AIdeation/source:alle');
  assert.notEqual(
    workerIdFor({}, '/AIdeation/source', 'alle', 'mac'),
    workerIdFor({}, '/AIdeation/agent', 'alle', 'mac'),
    'die Kopie „AIdeation/agent“ ist ein anderer Worker',
  );
  assert.equal(workerIdFor({ DEV_LOG_WORKER_ID: ' container ' }, '/app', 'alle', 'x'), 'container');
  assert.equal(workerIdFor({ DEV_LOG_WORKER_ID: '  ' }, '/app', 'alle', 'x'), 'x:/app:alle');
});
