import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import type { Principal } from './roles.js';
import { serveRoutes } from './serve-routes.test.js';
import { completedSprintUsage, costOfTokens, registerUsageRoutes, tokenPriceUsd } from './usage.js';
import { withMigratedDatabase } from '../db/test-database.test.js';

const admin: Principal = { id: null, username: 'admin', displayName: 'Admin', roles: ['admin'] };
const HOUR = 3_600_000;

interface Step {
  agent: string;
  status: 'passed' | 'failed';
  hours: number;
  tokens: number;
  cost: number;
  model: string;
  output?: string;
  routing?: string;
}

async function order(
  pool: Pool,
  project: string,
  values: { title: string; kind?: string; category?: string | null; status?: string; sprint?: string | null },
  estimate: { hours: number; tokens: number } | null,
): Promise<string> {
  return (
    await pool.query<{ id: string }>(
      `INSERT INTO development_items (project_slug, title, kind, category, status, sprint_id, effort_hours, token_estimate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        project,
        values.title,
        values.kind ?? 'feature',
        values.category ?? null,
        values.status ?? 'backlog',
        values.sprint ?? null,
        estimate?.hours ?? null,
        estimate?.tokens ?? null,
      ],
    )
  ).rows[0]!.id;
}

/** Ein Lauf des Auftrags mit den gemessenen Schritten. */
async function run(pool: Pool, project: string, orderId: string, steps: Step[]): Promise<void> {
  const runId = (
    await pool.query<{ id: string }>(
      `INSERT INTO agent_runs (project_slug, development_id, status) VALUES ($1, $2, 'passed') RETURNING id`,
      [project, orderId],
    )
  ).rows[0]!.id;
  for (const [index, step] of steps.entries()) {
    await pool.query(
      `INSERT INTO agent_run_steps (run_id, position, agent_name, phase, status, duration_ms, tokens, cost_usd, model,
                                    output, routing_rule)
       VALUES ($1, $2, $3, 'while_task', $4, $5, $6, $7, $8, $9, $10)`,
      [
        runId,
        index + 1,
        step.agent,
        step.status,
        Math.round(step.hours * HOUR),
        step.tokens,
        step.cost,
        step.model,
        step.output ?? '',
        step.routing ?? null,
      ],
    );
  }
}

async function systemUsage(
  pool: Pool,
  project: string,
  role: string,
  values: { tokens: number; ms: number; cost: number; success: boolean; prompt?: string; at?: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO agent_usage (project_slug, role, tokens, duration_ms, cost_usd, success, prompt, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, NOW()))`,
    [project, role, values.tokens, values.ms, values.cost, values.success, values.prompt ?? null, values.at ?? null],
  );
}

test('Verbrauch auf PostgreSQL: Bereiche, Arten, Agents, Routing und Sprint-Kapazität', async (t) => {
  await withMigratedDatabase(t, 'devlog_usage', async (db) => {
    const pool = db as unknown as Pool;
    await pool.query(`INSERT INTO projects (slug, name, repository) VALUES
      ('velo', 'Velowerk', '/srv/velo'), ('fremd', 'Fremd', '/srv/fremd'), ('leer', 'Leer', '/srv/leer')`);
    const sprint = async (name: string, status: string, end: string | null) =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO sprints (project_slug, name, status, end_date) VALUES ('velo', $1, $2, $3) RETURNING id`,
          [name, status, end],
        )
      ).rows[0]!.id;
    const recent = await sprint('Sprint 2', 'completed', '2026-10-20');
    const older = await sprint('Sprint 1', 'completed', '2026-10-10');
    const active = await sprint('Sprint 3', 'active', null);

    const login = await order(
      pool,
      'velo',
      { title: 'Login', category: 'frontend', status: 'done', sprint: recent },
      { hours: 2, tokens: 100_000 },
    );
    await run(pool, 'velo', login, [
      { agent: 'Entwickler', status: 'passed', hours: 1, tokens: 60_000, cost: 0.6, model: 'sonnet' },
      { agent: 'Tester', status: 'failed', hours: 0.5, tokens: 20_000, cost: 0.2, model: 'sonnet', output: 'kaputt' },
    ]);
    // Zweiter Lauf: vom Routing auf ein lokales Modell gelegt (kostet nichts).
    await run(pool, 'velo', login, [
      { agent: 'Entwickler', status: 'passed', hours: 0.5, tokens: 20_000, cost: 0, model: 'lokal', routing: 'klein' },
    ]);
    const crash = await order(
      pool,
      'velo',
      { title: 'Absturz', kind: 'bug', category: 'backend', status: 'in_progress', sprint: older },
      null,
    );
    // Unterbrochen (Neustart des Workers) zählt nicht als Fehlschlag des Agents.
    await run(pool, 'velo', crash, [
      {
        agent: 'Tester',
        status: 'failed',
        hours: 0.25,
        tokens: 10_000,
        cost: 0.1,
        model: 'sonnet',
        output: 'halb\nUnterbrochen: Worker neu gestartet',
      },
    ]);
    await order(pool, 'velo', { title: 'Später', sprint: active }, { hours: 1, tokens: 5_000 });

    await systemUsage(pool, 'velo', 'assistant', {
      tokens: 5_000,
      ms: 600_000,
      cost: 0.05,
      success: true,
      prompt: 'Wie viele Aufträge?',
      at: '2026-10-29T10:00:00Z',
    });
    await systemUsage(pool, 'velo', 'assistant', { tokens: 1_000, ms: 0, cost: 0.01, success: false });
    await systemUsage(pool, 'velo', 'author', {
      tokens: 4_000,
      ms: 0.5 * HOUR,
      cost: 0.04,
      success: true,
      prompt: 'Schreibe einen Auftrag',
      at: '2026-10-29T11:00:00Z',
    });
    await systemUsage(pool, 'velo', 'eigen', { tokens: 1_000, ms: 0, cost: 0, success: true });

    // Fremdes Projekt mit anderem Preis: zählt nirgends mit, ausser als Rückfall für den Preis.
    const foreign = await order(pool, 'fremd', { title: 'Fremd' }, null);
    await run(pool, 'fremd', foreign, [
      { agent: 'Entwickler', status: 'passed', hours: 9, tokens: 1_000, cost: 1, model: 'opus' },
    ]);

    const client = await serveRoutes(admin, (router) => registerUsageRoutes(router, pool));
    try {
      await t.test('Aufträge, Bereiche und Arten', async () => {
        const usage = (await client.call('GET', '/projects/velo/usage')).body;
        const byTitle = Object.fromEntries(
          usage.orders.map((entry: { title: string }) => [entry.title, entry] as [string, unknown]),
        );
        assert.deepEqual(byTitle.Login, {
          id: login,
          title: 'Login',
          kind: 'feature',
          category: 'frontend',
          status: 'done',
          runs: 2,
          estimate: { hours: 2, tokens: 100_000 },
          actual: { tokens: 100_000, hours: 2, costUsd: 0.8 },
        });
        assert.deepEqual((byTitle.Später as { actual: unknown; runs: number }).actual, {
          tokens: 0,
          hours: 0,
          costUsd: 0,
        });
        assert.deepEqual(
          usage.byCategory.map((entry: { key: string; count: number; actual: { tokens: number } }) => [
            entry.key,
            entry.count,
            entry.actual.tokens,
          ]),
          [
            ['frontend', 1, 100_000],
            ['backend', 1, 10_000],
            ['none', 1, 0],
          ],
        );
        assert.deepEqual(usage.byKind, [
          {
            key: 'order',
            count: 2,
            actual: { tokens: 100_000, hours: 2, costUsd: 0.8 },
            estimate: { hours: 3, tokens: 105_000 },
          },
          {
            key: 'bug',
            count: 1,
            actual: { tokens: 10_000, hours: 0.25, costUsd: 0.1 },
            estimate: { hours: 0, tokens: 0 },
          },
          {
            key: 'dashboard',
            count: 2,
            actual: { tokens: 6_000, hours: 0.17, costUsd: 0.06 },
            estimate: { hours: 0, tokens: 0 },
          },
          {
            key: 'planning',
            count: 2,
            actual: { tokens: 5_000, hours: 0.5, costUsd: 0.04 },
            estimate: { hours: 0, tokens: 0 },
          },
        ]);
      });

      await t.test('Agents im Vergleich: echte Fehlschläge, Anteile, Systemagents mit Namen', async () => {
        const usage = (await client.call('GET', '/projects/velo/usage')).body;
        assert.deepEqual(
          usage.agents.map(
            (entry: {
              agent: string;
              source: string;
              count: number;
              failed: number;
              successRate: number;
              share: number;
            }) => [entry.agent, entry.source, entry.count, entry.failed, entry.successRate, entry.share],
          ),
          [
            ['Entwickler', 'workflow', 2, 0, 100, 66.1],
            ['Tester', 'workflow', 2, 1, 50, 24.8],
            ['Dashboard-Assistent', 'system', 2, 1, 50, 5],
            ['Auftragsautor (Ideen)', 'system', 1, 0, 100, 3.3],
            ['eigen', 'system', 1, 0, 100, 0.8],
          ],
        );
        const developer = usage.agents[0];
        assert.equal(developer.avgTokens, 40_000);
        assert.equal(developer.avgSeconds, 2_700);
        assert.deepEqual(usage.totals, {
          tokens: 121_000,
          hours: 2.92,
          costUsd: 1,
          estimateTokens: 100_000,
          estimateActualTokens: 100_000,
        });
      });

      await t.test('Routing: Ersparnis mit dem Preis des Projekts, Verbrauch je Modell', async () => {
        const { routing } = (await client.call('GET', '/projects/velo/usage')).body;
        assert.deepEqual(routing, {
          routedSteps: 1,
          localTokens: 20_000,
          savedUsd: 0.2,
          byModel: [
            { model: 'sonnet', count: 3, routed: 0, tokens: 90_000, costUsd: 0.9 },
            { model: 'lokal', count: 1, routed: 1, tokens: 20_000, costUsd: 0 },
          ],
        });
      });

      await t.test('Preis je Token: erst das Projekt, sonst alle Projekte, ohne Messung keiner', async () => {
        assert.equal(await tokenPriceUsd(pool, 'velo'), 1 / 100_000);
        assert.ok(Math.abs((await tokenPriceUsd(pool, 'leer'))! - 2 / 101_000) < 1e-12);
        assert.equal(costOfTokens(1_234, 1 / 100_000), 0.01);
        assert.equal(costOfTokens(1_234, null), null);
        await pool.query(`UPDATE agent_run_steps SET cost_usd = 0`);
        await pool.query(`UPDATE agent_usage SET cost_usd = 0`);
        assert.equal(await tokenPriceUsd(pool, 'velo'), null, 'nur lokale Modelle: kein Preis');
        const { routing } = (await client.call('GET', '/projects/velo/usage')).body;
        assert.equal(routing.savedUsd, null);
      });

      await t.test('Sprint-Kapazität: nur erledigte Aufträge abgeschlossener Sprints, neueste zuerst', async () => {
        assert.deepEqual(await completedSprintUsage(pool, 'velo'), [
          { tokens: 100_000, hours: 2, costUsd: 0 },
          { tokens: 0, hours: 0, costUsd: 0 },
        ]);
        assert.equal((await completedSprintUsage(pool, 'velo', 1)).length, 1);
        assert.deepEqual(await completedSprintUsage(pool, 'fremd'), []);
      });

      await t.test('Prompt-Protokoll: neueste zuerst, Filter nur mit gültiger Rolle', async () => {
        const all = (await client.call('GET', '/projects/velo/usage/prompts')).body.prompts;
        assert.deepEqual(
          all.map((entry: { agent: string; prompt: string; tokens: number }) => [
            entry.agent,
            entry.prompt,
            entry.tokens,
          ]),
          [
            ['Auftragsautor (Ideen)', 'Schreibe einen Auftrag', 4_000],
            ['Dashboard-Assistent', 'Wie viele Aufträge?', 5_000],
          ],
        );
        const author = (await client.call('GET', '/projects/velo/usage/prompts?role=author')).body.prompts;
        assert.deepEqual(
          author.map((entry: { role: string }) => entry.role),
          ['author'],
        );
        const invalid = (await client.call('GET', "/projects/velo/usage/prompts?role=x'%20OR%201=1")).body.prompts;
        assert.equal(invalid.length, 2, 'ungültige Rolle wird ignoriert, nicht ins SQL übernommen');
      });

      await t.test('Ungültiges Projekt: 400, fremdes Projekt sieht nichts von velo', async () => {
        assert.equal((await client.call('GET', '/projects/Ungültig!/usage')).status, 400);
        assert.equal((await client.call('GET', '/projects/Ungültig!/usage/prompts')).status, 400);
        const foreignUsage = (await client.call('GET', '/projects/fremd/usage')).body;
        assert.deepEqual(
          foreignUsage.orders.map((entry: { title: string }) => entry.title),
          ['Fremd'],
        );
        assert.equal(foreignUsage.totals.tokens, 1_000);
      });
    } finally {
      await client.close();
    }
  });
});
