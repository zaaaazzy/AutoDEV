import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import type { Principal } from './roles.js';
import { serveRoutes } from './serve-routes.test.js';
import { beatHeartbeat, DEFAULT_MAX_AGENTS, readMaxAgents, registerWorkerRoutes } from './worker.js';
import { withMigratedDatabase } from '../db/test-database.test.js';

const admin: Principal = { id: null, username: 'admin', displayName: 'Admin', roles: ['admin'] };

/** Agent eines Projekts; liefert die ID. */
async function agent(pool: Pool, project: string, name: string, role: string, phase = 'while_task'): Promise<string> {
  return (
    await pool.query<{ id: string }>(
      `INSERT INTO agents (project_slug, name, role, phase) VALUES ($1, $2, $3, $4) RETURNING id`,
      [project, name, role, phase],
    )
  ).rows[0]!.id;
}

/** Auftrag mit laufendem Lauf, in dem der Agent gerade einen Schritt ausführt. */
async function runningStep(
  pool: Pool,
  project: string,
  agentId: string,
  title: string,
  sprintId: string | null = null,
): Promise<{ order: string; run: string }> {
  const order = (
    await pool.query<{ id: string }>(
      `INSERT INTO development_items (project_slug, title, status, sprint_id) VALUES ($1, $2, 'in_progress', $3)
       RETURNING id`,
      [project, title, sprintId],
    )
  ).rows[0]!.id;
  const run = (
    await pool.query<{ id: string }>(
      `INSERT INTO agent_runs (project_slug, development_id, status) VALUES ($1, $2, 'running') RETURNING id`,
      [project, order],
    )
  ).rows[0]!.id;
  await pool.query(
    `INSERT INTO agent_run_steps (run_id, position, agent_id, agent_name, phase, status)
     VALUES ($1, 1, $2, 'Agent', 'while_task', 'running')`,
    [run, agentId],
  );
  return { order, run };
}

test('Worker-Routen auf PostgreSQL', async (t) => {
  await withMigratedDatabase(t, 'devlog_worker_routes', async (db) => {
    const pool = db as unknown as Pool;
    await pool.query(`INSERT INTO projects (slug, name, repository) VALUES
      ('velo', 'Velowerk', '/srv/velo'), ('fremd', 'Fremd', '/srv/fremd')`);
    const asAdmin = await serveRoutes(admin, (router) => registerWorkerRoutes(router, pool));
    // Ein Benutzer, der nur „velo“ sehen darf (allowedProjects setzt sonst der zentrale Rechtewächter).
    const asVelo = await serveRoutes(admin, (router) => registerWorkerRoutes(router, pool), {
      allowedProjects: new Set(['velo']),
    });
    try {
      await t.test('Parallele Agents: Standard ohne Eintrag, nur 1 bis 8 werden gespeichert', async () => {
        assert.equal(await readMaxAgents(pool), DEFAULT_MAX_AGENTS);
        assert.deepEqual((await asAdmin.call('GET', '/settings')).body, { maxConcurrentAgents: 2, limit: 8 });
        for (const value of [0, 9, 2.5, '3', null, 'viele']) {
          const response = await asAdmin.call('PUT', '/settings', { maxConcurrentAgents: value });
          assert.equal(response.status, value === '3' ? 200 : 400, JSON.stringify(value));
        }
        assert.equal(await readMaxAgents(pool), 3, 'die Zahl als Text gilt, alles andere bleibt ungespeichert');
        assert.deepEqual((await asAdmin.call('PUT', '/settings', { maxConcurrentAgents: 8 })).body, {
          maxConcurrentAgents: 8,
          limit: 8,
        });
        assert.equal(await readMaxAgents(pool), 8);
        // Ein von Hand verdorbener Wert fällt auf den Standard zurück, statt den Worker zu blockieren.
        await pool.query(`UPDATE app_settings SET value = '99' WHERE key = 'max_concurrent_agents'`);
        assert.equal(await readMaxAgents(pool), DEFAULT_MAX_AGENTS);
      });

      await t.test('Lebenszeichen: Neustart setzt die Startzeit, ein normaler Schlag behält sie', async () => {
        await beatHeartbeat(pool, 'velo', 30, null, true);
        await pool.query(
          `UPDATE worker_heartbeats SET started_at = NOW() - INTERVAL '1 hour' WHERE project_slug = 'velo'`,
        );
        await beatHeartbeat(pool, 'velo', 45, 'Netz weg');
        const kept = (
          await pool.query(
            `SELECT interval_seconds, last_error, pid, started_at < NOW() - INTERVAL '30 minutes' AS old
               FROM worker_heartbeats WHERE project_slug = 'velo'`,
          )
        ).rows[0];
        assert.deepEqual(kept, { interval_seconds: 45, last_error: 'Netz weg', pid: process.pid, old: true });
        await beatHeartbeat(pool, 'velo', 45, null, true);
        const restarted = (
          await pool.query(`SELECT started_at > NOW() - INTERVAL '1 minute' AS fresh FROM worker_heartbeats`)
        ).rows[0];
        assert.equal(restarted.fresh, true);
      });

      await t.test(
        'Agent-Status: online nur mit frischem Lebenszeichen, fremde Projekte bleiben verborgen',
        async () => {
          const developer = await agent(pool, 'fremd', 'Entwickler', 'developer');
          await runningStep(pool, 'fremd', developer, 'Geheimer Auftrag');
          const all = (await asAdmin.call('GET', '/agent-status')).body;
          assert.deepEqual(
            all.projects.map((project: { slug: string; online: boolean }) => [project.slug, project.online]),
            [
              ['fremd', false],
              ['velo', true],
            ],
          );
          assert.deepEqual(
            all.running.map((entry: { title: string }) => entry.title),
            ['Geheimer Auftrag'],
          );
          const own = await asVelo.call('GET', '/agent-status');
          assert.equal(own.headers.get('cache-control'), 'no-store');
          assert.deepEqual(
            own.body.projects.map((project: { slug: string }) => project.slug),
            ['velo'],
          );
          assert.deepEqual(own.body.running, [], 'kein Titel aus dem fremden Projekt');
          await pool.query(`UPDATE worker_heartbeats SET last_seen = NOW() - INTERVAL '2 minutes'`);
          const stale = (await asVelo.call('GET', '/agent-status')).body;
          assert.equal(stale.projects[0].online, false);
          await pool.query(`TRUNCATE agent_runs, development_items, agents CASCADE`);
        },
      );

      await t.test('Aktivität eines Agents: nur eigene Schritte, anstehend nur, was er übernehmen wird', async () => {
        assert.equal((await asAdmin.call('GET', '/projects/velo/agents/kein-uuid/activity')).status, 400);
        const tester = await agent(pool, 'velo', 'Tester', 'tester', 'after_task');
        const author = await agent(pool, 'velo', 'Autor', 'author', 'pre_task');
        const sprint = (
          await pool.query<{ id: string }>(
            `INSERT INTO sprints (project_slug, name, status) VALUES ('velo', 'Sprint 1', 'active') RETURNING id`,
          )
        ).rows[0]!.id;
        await runningStep(pool, 'velo', tester, 'Login testen', sprint);
        const idea = (
          await pool.query<{ id: string }>(
            `INSERT INTO ideation_items (project_slug, title) VALUES ('velo', 'Idee') RETURNING id`,
          )
        ).rows[0]!.id;
        await pool.query(
          `INSERT INTO development_items (project_slug, title, status, sprint_id, agent_id, ideation_id) VALUES
             ('velo', 'Im Sprint', 'planned', $1, NULL, NULL),
             ('velo', 'Fest zugewiesen', 'planned', NULL, $2, NULL),
             ('velo', 'Ohne Sprint', 'planned', NULL, NULL, NULL),
             ('velo', 'Aus Idee', 'planned', $1, NULL, $3),
             ('velo', 'Schon fertig', 'done', $1, NULL, NULL)`,
          [sprint, tester, idea],
        );
        const activity = (await asAdmin.call('GET', `/projects/velo/agents/${tester}/activity`)).body;
        assert.equal(activity.activity.length, 1);
        assert.equal(activity.activity[0].orderTitle, 'Login testen');
        assert.equal(activity.activity[0].sprintName, 'Sprint 1');
        assert.deepEqual(activity.upcoming.map((order: { title: string }) => order.title).sort(), [
          'Aus Idee',
          'Fest zugewiesen',
          'Im Sprint',
        ]);
        // Der Auftragsautor übernimmt keine Aufträge, die schon aus einer Idee entstanden sind.
        const authorView = (await asAdmin.call('GET', `/projects/velo/agents/${author}/activity`)).body;
        assert.deepEqual(authorView.activity, []);
        assert.deepEqual(
          authorView.upcoming.map((order: { title: string }) => order.title),
          ['Im Sprint'],
        );
        // Aus einem anderen Projekt abgefragt, ist der Agent unbekannt.
        assert.deepEqual((await asAdmin.call('GET', `/projects/fremd/agents/${tester}/activity`)).body, {
          activity: [],
          upcoming: [],
        });
      });

      await t.test('Abbrechen: 404, wenn der Agent nicht läuft; 202 mit Abbruch, wenn er läuft', async () => {
        const idle = await agent(pool, 'velo', 'Doku', 'documenter', 'on_done');
        assert.equal((await asAdmin.call('POST', `/projects/velo/agents/${idle}/cancel`)).status, 404);
        assert.equal((await asAdmin.call('POST', '/projects/Ungültig!/agents/x/cancel')).status, 400);
        const tester = (await pool.query<{ id: string }>(`SELECT id FROM agents WHERE name = 'Tester'`)).rows[0]!.id;
        await beatHeartbeat(pool, 'velo', 30);
        const response = await asAdmin.call('POST', `/projects/velo/agents/${tester}/cancel`);
        assert.equal(response.status, 202);
        assert.deepEqual(response.body, { cancelling: true, closed: 0 }, 'Worker lebt: er bricht selbst ab');
        const step = (await pool.query(`SELECT cancel_requested FROM agent_run_steps WHERE agent_id = $1`, [tester]))
          .rows[0];
        assert.equal(step.cancel_requested, true);
      });

      await t.test('Projektübersicht: laufende, entstehende und von Hand gestartete Arbeit', async () => {
        assert.equal((await asAdmin.call('GET', '/projects/Ungültig!/worker')).status, 400);
        await agent(pool, 'velo', 'Autor 2', 'author', 'pre_task');
        await pool.query(
          `INSERT INTO ideation_items (project_slug, title, status, progress_agent, drafting_started_at)
           VALUES ('velo', 'Dunkelmodus', 'drafting', 'author', NOW()), ('velo', 'Später', 'requested', NULL, NULL)`,
        );
        const doku = (await pool.query<{ id: string }>(`SELECT id FROM agents WHERE name = 'Doku'`)).rows[0]!.id;
        await pool.query(
          `INSERT INTO chat_messages (project_slug, role, content, status, agent_id) VALUES
             ('velo', 'user', 'Bitte   das Handbuch prüfen', 'pending', $1),
             ('velo', 'user', 'Wie viele Aufträge sind offen?', 'processing', NULL)`,
          [doku],
        );
        await pool.query(
          `INSERT INTO visionary_runs (project_slug, status, progress) VALUES ('velo', 'running', NULL)`,
        );
        await pool.query(
          `INSERT INTO git_fix_requests (project_slug, fix, role, status, created_at) VALUES
             ('velo', 'save_wip', 'live', 'done', NOW() - INTERVAL '1 hour'),
             ('velo', 'checkout_main', 'agents', 'failed', NOW())`,
        );
        const body = (await asAdmin.call('GET', '/projects/velo/worker')).body;
        assert.equal(body.online, true);
        assert.equal(body.worker.intervalSeconds, 30);
        assert.deepEqual(
          body.running.map((entry: { title: string }) => entry.title),
          ['Login testen'],
        );
        const byName = new Map<string, Record<string, unknown>>(
          body.agents.map((entry: { name: string }) => [entry.name, entry]),
        );
        assert.equal(byName.get('Tester')?.active, true);
        assert.equal(byName.get('Tester')?.orderTitle, 'Login testen');
        assert.equal(byName.get('Tester')?.sprintName, 'Sprint 1');
        // Nur ein Autor schreibt am Entwurf; der zweite bleibt frei.
        const authors = body.agents.filter((entry: { role: string }) => entry.role === 'author');
        assert.deepEqual(
          authors.map((entry: { active: boolean; orderTitle: string | null }) => [entry.active, entry.orderTitle]),
          [
            [true, 'Neuer Auftrag: Dunkelmodus'],
            [false, null],
          ],
        );
        assert.equal(byName.get('Doku')?.waiting, true);
        assert.equal(byName.get('Doku')?.orderTitle, 'Wartet – Chat: Bitte das Handbuch prüfen');
        assert.deepEqual(
          { active: byName.get('Dashboard-Assistent')?.active, title: byName.get('Dashboard-Assistent')?.orderTitle },
          { active: true, title: 'Chat: Wie viele Aufträge sind offen?' },
        );
        assert.equal(byName.get('Visionär')?.orderTitle, 'Ideen sammeln: läuft …');
        assert.deepEqual(
          body.drafts.map((draft: { title: string }) => draft.title),
          ['Dunkelmodus', 'Später'],
        );
        assert.equal(body.git.fix.fix, 'checkout_main', 'nur die letzte angeforderte Lösung');
        assert.equal(body.git.state, null);
        assert.equal(body.git.stale, true);
      });

      await t.test(
        'Projektübersicht: offene Rückfrage des Assistenten, Visionär angefragt, Worker offline',
        async () => {
          await pool.query(`UPDATE chat_messages SET status = 'done'`);
          await pool.query(
            `INSERT INTO chat_messages (project_slug, role, content, status, question, created_at)
           VALUES ('velo', 'assistant', 'Frage', 'done', 'Soll der Sprint verlängert werden?', NOW() + INTERVAL '1 second')`,
          );
          await pool.query(`UPDATE visionary_runs SET status = 'requested'`);
          await pool.query(`UPDATE worker_heartbeats SET last_seen = NOW() - INTERVAL '5 minutes'`);
          const body = (await asAdmin.call('GET', '/projects/velo/worker')).body;
          assert.equal(body.online, false);
          assert.equal(body.worker.online, false);
          const assistant = body.agents.find((entry: { id: string }) => entry.id === 'assistant');
          assert.deepEqual(
            [assistant.active, assistant.waiting, assistant.orderTitle],
            [false, true, 'Rückfrage: Soll der Sprint verlängert werden?'],
          );
          const visionary = body.agents.find((entry: { id: string }) => entry.id === 'visionary');
          assert.equal(visionary.orderTitle, 'Lauf angefragt – wartet auf den Worker');
          // Beantwortet: keine Rückfrage mehr.
          await pool.query(
            `INSERT INTO chat_messages (project_slug, role, content, status, created_at)
           VALUES ('velo', 'user', 'Ja', 'done', NOW() + INTERVAL '2 seconds')`,
          );
          const answered = (await asAdmin.call('GET', '/projects/velo/worker')).body;
          const after = answered.agents.find((entry: { id: string }) => entry.id === 'assistant');
          assert.deepEqual([after.waiting, after.orderTitle], [false, null]);
        },
      );

      await t.test('Projektübersicht ohne Lebenszeichen: worker ist null', async () => {
        const body = (await asAdmin.call('GET', '/projects/fremd/worker')).body;
        assert.equal(body.worker, null);
        assert.equal(body.online, false);
        assert.deepEqual(
          body.agents.map((entry: { id: string }) => entry.id),
          ['assistant', 'visionary'],
        );
      });
    } finally {
      await asAdmin.close();
      await asVelo.close();
    }
  });
});
