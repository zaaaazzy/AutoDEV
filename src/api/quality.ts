import type { Router } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import { parseProjectSlug } from '../core/validation.js';
import { realFailureSql } from '../core/interrupted-steps.js';

/** Auswertung „Was klappt“: wo der Ablauf hilft und wo er hängen bleibt (letzte 30 Tage). */
export interface QualityStats {
  days: number;
  orders: { finished: number; firstTry: number; firstTryRate: number | null };
  corrections: { count: number; succeeded: number; rate: number | null };
  transient: { count: number; succeeded: number; rate: number | null };
  blocked: { resolved: number; avgHours: number | null; open: number; longestOpenHours: number | null };
  budgetStops: number;
  agents: { agent: string; engine: string; steps: number; failed: number; failRate: number }[];
}

const rate = (part: number, total: number): number | null => (total ? Math.round((part / total) * 100) : null);
const num = (value: unknown): number => Number(value ?? 0) || 0;
const hours = (value: unknown): number | null =>
  value === null || value === undefined ? null : Math.round(Number(value) * 10) / 10;

export async function collectQuality(pool: Pool, slug: string, days = 30): Promise<QualityStats> {
  const since = `NOW() - make_interval(days => $2)`;
  const [orders, corrections, transient, blocked, open, budget, agents] = await Promise.all([
    pool.query<{ finished: string; first: string }>(
      `SELECT COUNT(*) AS finished,
              COUNT(*) FILTER (WHERE retry_count = 0 AND failure_bug_id IS NULL
                AND (SELECT COUNT(*) FROM agent_runs r WHERE r.development_id = d.id) <= 1) AS first
         FROM development_items d
        WHERE project_slug = $1 AND status = 'done' AND completed_at >= ${since}`,
      [slug, days],
    ),
    pool.query<{ count: string; succeeded: string }>(
      `SELECT COUNT(DISTINCT r.id) AS count, COUNT(DISTINCT r.id) FILTER (WHERE r.status = 'passed') AS succeeded
         FROM agent_run_steps s JOIN agent_runs r ON r.id = s.run_id
        WHERE r.project_slug = $1 AND r.started_at >= ${since}
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.events) e WHERE e->>'text' LIKE 'Zurück an den Entwickler%')`,
      [slug, days],
    ),
    pool.query<{ count: string; succeeded: string }>(
      `SELECT COUNT(*) AS count, COUNT(*) FILTER (WHERE s.status = 'passed') AS succeeded
         FROM agent_run_steps s JOIN agent_runs r ON r.id = s.run_id
        WHERE r.project_slug = $1 AND r.started_at >= ${since}
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.events) e WHERE e->>'text' LIKE 'Vorübergehender Fehler%')`,
      [slug, days],
    ),
    pool.query<{ resolved: string; avg: string | null }>(
      `WITH changes AS (
         SELECT e.development_id, e.at, e.detail,
                LEAD(e.at) OVER (PARTITION BY e.development_id ORDER BY e.at, e.id) AS left_at
           FROM development_events e JOIN development_items d ON d.id = e.development_id
          WHERE d.project_slug = $1 AND e.kind = 'status')
       SELECT COUNT(*) AS resolved, AVG(EXTRACT(EPOCH FROM (left_at - at)) / 3600) AS avg
         FROM changes WHERE detail LIKE '%>blocked' AND left_at IS NOT NULL AND left_at >= ${since}`,
      [slug, days],
    ),
    pool.query<{ open: string; longest: string | null }>(
      `SELECT COUNT(*) AS open,
              MAX(EXTRACT(EPOCH FROM (NOW() - COALESCE(
                (SELECT MAX(e.at) FROM development_events e WHERE e.development_id = d.id AND e.detail LIKE '%>blocked'),
                d.updated_at))) / 3600) AS longest
         FROM development_items d WHERE d.project_slug = $1 AND d.status = 'blocked'`,
      [slug],
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM development_items
        WHERE project_slug = $1 AND action_todo LIKE 'Kostengrenze%'`,
      [slug],
    ),
    pool.query<{ agent: string; engine: string; steps: string; failed: string }>(
      `SELECT s.agent_name AS agent,
              CASE WHEN a.command IS NULL OR cardinality(a.command) = 0 THEN 'Standard'
                   ELSE regexp_replace(a.command[1], '^.*/', '') END AS engine,
              COUNT(*) AS steps, COUNT(*) FILTER (WHERE ${realFailureSql('s')}) AS failed
         FROM agent_run_steps s JOIN agent_runs r ON r.id = s.run_id
         LEFT JOIN agents a ON a.id = s.agent_id
        WHERE r.project_slug = $1 AND r.started_at >= ${since} AND s.status IN ('passed', 'failed')
        GROUP BY 1, 2 ORDER BY COUNT(*) FILTER (WHERE ${realFailureSql('s')}) DESC, COUNT(*) DESC LIMIT 20`,
      [slug, days],
    ),
  ]);
  const finished = num(orders.rows[0]?.finished);
  const firstTry = num(orders.rows[0]?.first);
  const correctionCount = num(corrections.rows[0]?.count);
  const correctionOk = num(corrections.rows[0]?.succeeded);
  const transientCount = num(transient.rows[0]?.count);
  const transientOk = num(transient.rows[0]?.succeeded);
  return {
    days,
    orders: { finished, firstTry, firstTryRate: rate(firstTry, finished) },
    corrections: { count: correctionCount, succeeded: correctionOk, rate: rate(correctionOk, correctionCount) },
    transient: { count: transientCount, succeeded: transientOk, rate: rate(transientOk, transientCount) },
    blocked: {
      resolved: num(blocked.rows[0]?.resolved),
      avgHours: hours(blocked.rows[0]?.avg),
      open: num(open.rows[0]?.open),
      longestOpenHours: hours(open.rows[0]?.longest),
    },
    budgetStops: num(budget.rows[0]?.count),
    agents: agents.rows.map((row) => ({
      agent: row.agent,
      engine: row.engine,
      steps: num(row.steps),
      failed: num(row.failed),
      failRate: rate(num(row.failed), num(row.steps)) ?? 0,
    })),
  };
}

export function registerQualityRoutes(app: Router, pool: Pool): void {
  app.get('/projects/:slug/quality', access({ tenant: 'project' }), async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
      response.json(await collectQuality(pool, slug));
    } catch (error) {
      next(error);
    }
  });
}
