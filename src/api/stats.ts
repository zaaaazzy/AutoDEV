import type { Router } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import { localTimeZone } from '../core/time-zone.js';
import { parseProjectSlug } from '../core/validation.js';

type CountRow = { key: string; count: string };
const counts = (rows: CountRow[]): Record<string, number> =>
  Object.fromEntries(rows.map((row) => [row.key, Number(row.count)]));

async function sprintStats(pool: Pool, slug: string): Promise<Record<string, unknown> | null> {
  const timeZone = localTimeZone();
  const active = (
    await pool.query<{ id: string; name: string; startDate: string; endDate: string | null }>(
      `SELECT id, name, to_char(COALESCE(start_date, (created_at AT TIME ZONE $2::text)::date), 'YYYY-MM-DD') AS "startDate",
            to_char(end_date, 'YYYY-MM-DD') AS "endDate"
       FROM sprints WHERE project_slug = $1 AND status = 'active'`,
      [slug, timeZone],
    )
  ).rows[0];
  if (!active) {
    return null;
  }
  // Tage in Ortszeit (DEV_LOG_TIMEZONE): ein Auftrag, der um 01:30 vor Ort fertig wird, zählt zu diesem Tag.
  const burn = await pool.query<{ day: string; remaining: string }>(
    `WITH totals AS (SELECT COUNT(*) AS total FROM development_items WHERE sprint_id = $1),
          days AS (
            SELECT d::date AS day
              FROM generate_series($2::date, GREATEST($2::date, LEAST(COALESCE($3::date, $2::date + 13), (NOW() AT TIME ZONE $4::text)::date)), '1 day') d
          )
     SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
            (totals.total - (SELECT COUNT(*) FROM development_items
                              WHERE sprint_id = $1 AND completed_at IS NOT NULL
                                AND (completed_at AT TIME ZONE $4::text)::date <= days.day)) AS remaining
       FROM days, totals ORDER BY days.day`,
    [active.id, active.startDate, active.endDate, timeZone],
  );
  const progress = (
    await pool.query<{ total: string; done: string }>(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'done') AS done FROM development_items WHERE sprint_id = $1`,
      [active.id],
    )
  ).rows[0];
  const total = Number(progress?.total ?? 0);
  const done = Number(progress?.done ?? 0);
  return {
    ...active,
    total,
    done,
    percent: total ? Math.round((done / total) * 100) : 0,
    burndown: burn.rows.map((row) => ({ day: row.day, remaining: Number(row.remaining) })),
  };
}

export async function collectStats(pool: Pool, slug: string): Promise<Record<string, unknown>> {
  const [orders, kinds, ideas, bugs, severities, effort, tests, agentSteps, sprint, velocity, actual, testTotal] =
    await Promise.all([
      pool.query<CountRow>(
        'SELECT status AS key, COUNT(*) AS count FROM development_items WHERE project_slug = $1 GROUP BY status',
        [slug],
      ),
      pool.query<CountRow>(
        'SELECT kind AS key, COUNT(*) AS count FROM development_items WHERE project_slug = $1 GROUP BY kind',
        [slug],
      ),
      pool.query<CountRow>(
        'SELECT status AS key, COUNT(*) AS count FROM ideation_items WHERE project_slug = $1 GROUP BY status',
        [slug],
      ),
      pool.query<CountRow>(
        'SELECT status AS key, COUNT(*) AS count FROM bugs WHERE project_slug = $1 GROUP BY status',
        [slug],
      ),
      pool.query<CountRow>(
        `SELECT severity AS key, COUNT(*) AS count FROM bugs
        WHERE project_slug = $1 AND status IN ('open', 'in_progress') GROUP BY severity`,
        [slug],
      ),
      pool.query<{ planned: string; done: string; tokens: string }>(
        `SELECT COALESCE(SUM(effort_hours), 0) AS planned,
              COALESCE(SUM(effort_hours) FILTER (WHERE status = 'done'), 0) AS done,
              COALESCE(SUM(token_estimate), 0) AS tokens
         FROM development_items WHERE project_slug = $1`,
        [slug],
      ),
      pool.query<{ id: string; status: string; startedAt: string }>(
        `SELECT id, status, started_at AS "startedAt" FROM test_runs
        WHERE project_slug = $1 ORDER BY started_at DESC LIMIT 20`,
        [slug],
      ),
      pool.query<{ agent: string; passed: string; failed: string; skipped: string }>(
        `SELECT st.agent_name AS agent,
              COUNT(*) FILTER (WHERE st.status = 'passed') AS passed,
              COUNT(*) FILTER (WHERE st.status = 'failed') AS failed,
              COUNT(*) FILTER (WHERE st.status = 'skipped') AS skipped
         FROM agent_run_steps st JOIN agent_runs r ON r.id = st.run_id
        WHERE r.project_slug = $1 GROUP BY st.agent_name ORDER BY st.agent_name`,
        [slug],
      ),
      sprintStats(pool, slug),
      pool.query<{ name: string; status: string; total: string; done: string; hours: string }>(
        `SELECT s.name, s.status, COUNT(d.id) AS total, COUNT(d.id) FILTER (WHERE d.status = 'done') AS done,
              COALESCE(SUM(d.effort_hours) FILTER (WHERE d.status = 'done'), 0) AS hours
         FROM sprints s LEFT JOIN development_items d ON d.sprint_id = s.id
        WHERE s.project_slug = $1 GROUP BY s.id ORDER BY s.created_at DESC LIMIT 8`,
        [slug],
      ),
      pool.query<{ tokens: string; ms: string; cost: string }>(
        `SELECT COALESCE(SUM(st.tokens), 0) AS tokens, COALESCE(SUM(st.duration_ms), 0) AS ms,
              COALESCE(SUM(st.cost_usd), 0) AS cost
         FROM agent_run_steps st JOIN agent_runs r ON r.id = st.run_id WHERE r.project_slug = $1`,
        [slug],
      ),
      pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM test_runs WHERE project_slug = $1', [slug]),
    ]);

  const finishedTests = tests.rows.filter((run) => run.status !== 'running');
  return {
    orders: counts(orders.rows),
    kinds: counts(kinds.rows),
    ideas: counts(ideas.rows),
    bugs: counts(bugs.rows),
    openBugsBySeverity: counts(severities.rows),
    effort: {
      plannedHours: Number(effort.rows[0]?.planned ?? 0),
      doneHours: Number(effort.rows[0]?.done ?? 0),
      tokens: Number(effort.rows[0]?.tokens ?? 0),
    },
    actual: {
      tokens: Number(actual.rows[0]?.tokens ?? 0),
      hours: Math.round((Number(actual.rows[0]?.ms ?? 0) / 3_600_000) * 100) / 100,
      costUsd: Math.round(Number(actual.rows[0]?.cost ?? 0) * 100) / 100,
    },
    testRuns: {
      total: Number(testTotal.rows[0]?.count ?? 0),
      recent: [...tests.rows].reverse(),
      passRate: finishedTests.length
        ? Math.round((finishedTests.filter((run) => run.status === 'passed').length / finishedTests.length) * 100)
        : null,
    },
    agents: agentSteps.rows.map((row) => ({
      agent: row.agent,
      passed: Number(row.passed),
      failed: Number(row.failed),
      skipped: Number(row.skipped),
    })),
    sprint,
    velocity: [...velocity.rows].reverse().map((row) => ({
      name: row.name,
      status: row.status,
      total: Number(row.total),
      done: Number(row.done),
      hours: Number(row.hours),
    })),
  };
}

export function registerStatsRoutes(app: Router, pool: Pool): void {
  app.get('/projects/:slug/stats', access({ tenant: 'project' }), async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Ungültiges Projekt.' });
      return;
    }
    response.json(await collectStats(pool, slug));
  });
}
