import type { Router } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import { DEV_COLUMNS } from './development.js';
import { COMMENT_COLUMNS } from './idea-comments.js';
import { IDEA_COLUMNS, IDEA_SOURCES } from './ideation.js';
import { CLOSED_DEVELOPMENT_STATUSES, CLOSED_IDEATION_STATUSES } from '../core/status.js';
import { parseProjectSlug } from '../core/validation.js';

/** Höchstzahl abgeschlossener Einträge je Liste im Board; offene werden immer vollständig geladen. */
const CLOSED_LIMIT = 200;

/**
 * Lädt alle offenen Einträge (auch ohne Status) und nur die neuesten abgeschlossenen, neueste zuerst.
 * Beide Mengen schliessen sich aus, darum entstehen keine doppelten Einträge.
 */
async function openAndRecentClosed(
  pool: Pool,
  table: 'ideation_items' | 'development_items',
  columns: string,
  filter: string,
  params: unknown[],
  closed: readonly string[],
): Promise<unknown[]> {
  const status = `status = ANY($${params.length + 1}::text[])`;
  const result = await pool.query(
    `(SELECT ${columns} FROM ${table} WHERE ${filter} AND (${status}) IS NOT TRUE)
     UNION ALL
     (SELECT ${columns} FROM ${table} WHERE ${filter} AND ${status} ORDER BY created_at DESC LIMIT ${CLOSED_LIMIT})
     ORDER BY "createdAt" DESC`,
    [...params, closed],
  );
  return result.rows;
}

export function registerBoardRoutes(app: Router, pool: Pool): void {
  app.get('/projects/:slug/board', access({ tenant: 'project' }), async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Ungültiges Projekt.' });
      return;
    }
    // Optionaler Filter „Herkunft“ (?source=visionary); unbekannte Werte zeigen alle Ideen.
    const source =
      typeof request.query.source === 'string' && IDEA_SOURCES.has(request.query.source) ? request.query.source : null;
    const ideaFilter = 'project_slug = $1 AND ($2::text IS NULL OR source = $2)';
    const [ideas, development, comments] = await Promise.all([
      openAndRecentClosed(pool, 'ideation_items', IDEA_COLUMNS, ideaFilter, [slug, source], CLOSED_IDEATION_STATUSES),
      openAndRecentClosed(
        pool,
        'development_items',
        DEV_COLUMNS,
        'project_slug = $1',
        [slug],
        CLOSED_DEVELOPMENT_STATUSES,
      ),
      pool.query(
        `SELECT ${COMMENT_COLUMNS}
           FROM ideation_comments c JOIN ideation_items i ON i.id = c.ideation_id
          WHERE i.project_slug = $1 ORDER BY c.created_at`,
        [slug],
      ),
    ]);
    response.json({ ideas, development, comments: comments.rows });
  });

  app.get('/projects/:slug/agent-runs', access({ tenant: 'project' }), async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Ungültiges Projekt.' });
      return;
    }
    const runs = await pool.query(
      `SELECT r.id, r.development_id AS "developmentId", COALESCE(d.title, 'Auftrag gelöscht') AS title, r.status,
              r.started_at AS "startedAt", r.completed_at AS "completedAt"
         FROM agent_runs r LEFT JOIN development_items d ON d.id = r.development_id
        WHERE r.project_slug = $1 ORDER BY r.started_at DESC LIMIT 150`,
      [slug],
    );
    const steps = await pool.query(
      `SELECT run_id AS "runId", agent_id AS "agentId", position, agent_name AS "agentName", phase, status,
              exit_code AS "exitCode", duration_ms AS "durationMs", output, progress, events, tokens,
              cost_usd::float AS "costUsd", model, routing_rule AS "routingRule"
         FROM agent_run_steps WHERE run_id = ANY($1::uuid[]) ORDER BY run_id, position`,
      [runs.rows.map((run) => run.id)],
    );
    response.json({
      runs: runs.rows.map((run) => ({ ...run, steps: steps.rows.filter((step) => step.runId === run.id) })),
    });
  });
}
