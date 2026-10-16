import type { Express } from 'express';
import type { Pool } from 'pg';
import { parseProjectSlug } from '../core/validation.js';

export function registerTestRunRoutes(app: Express, pool: Pool): void {
  app.get('/api/projects/:slug/test-runs', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Invalid project slug.' });
      return;
    }
    const runs = await pool.query(
      `SELECT id, status, trigger, branch, commit_sha AS "commitSha",
              started_at AS "startedAt", completed_at AS "completedAt"
         FROM test_runs
        WHERE project_slug = $1
        ORDER BY started_at DESC
        LIMIT 50`,
      [slug],
    );
    const steps = await pool.query(
      `SELECT s.run_id AS "runId", s.position, s.command, s.status,
              s.exit_code AS "exitCode", s.duration_ms AS "durationMs", s.output
         FROM test_run_steps s
         JOIN test_runs r ON r.id = s.run_id
        WHERE r.project_slug = $1
          AND r.id = ANY($2::uuid[])
        ORDER BY r.started_at DESC, s.position`,
      [slug, runs.rows.map((run) => run.id)],
    );
    response.json({
      runs: runs.rows.map((run) => ({
        ...run,
        steps: steps.rows.filter((step) => step.runId === run.id),
      })),
    });
  });
}
