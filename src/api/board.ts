import type { Router } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import { DEV_COLUMNS } from './development.js';
import { COMMENT_COLUMNS } from './idea-comments.js';
import { IDEA_COLUMNS, IDEA_SOURCES } from './ideation.js';
import { parseProjectSlug } from '../core/validation.js';

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
    const [ideas, development, comments] = await Promise.all([
      pool.query(
        `SELECT ${IDEA_COLUMNS} FROM ideation_items WHERE project_slug = $1 AND ($2::text IS NULL OR source = $2)
          ORDER BY created_at DESC LIMIT 200`,
        [slug, source],
      ),
      pool.query(
        `SELECT ${DEV_COLUMNS} FROM development_items WHERE project_slug = $1
          ORDER BY created_at DESC LIMIT 200`,
        [slug],
      ),
      pool.query(
        `SELECT ${COMMENT_COLUMNS}
           FROM ideation_comments c JOIN ideation_items i ON i.id = c.ideation_id
          WHERE i.project_slug = $1 ORDER BY c.created_at`,
        [slug],
      ),
    ]);
    response.json({ ideas: ideas.rows, development: development.rows, comments: comments.rows });
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
