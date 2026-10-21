import type { Router } from 'express';
import type { Pool } from 'pg';
import { categoryOfCommand } from '../core/test-results.js';
import { isUuid, parseProjectSlug } from '../core/validation.js';

export function registerTestRunRoutes(app: Router, pool: Pool): void {
  app.get('/projects/:slug/test-runs', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Invalid project slug.' });
      return;
    }
    const runs = await pool.query(
      `SELECT id, status, trigger, branch, commit_sha AS "commitSha", platform,
              started_at AS "startedAt", completed_at AS "completedAt"
         FROM test_runs
        WHERE project_slug = $1
        ORDER BY started_at DESC
        LIMIT 50`,
      [slug],
    );
    const ids = runs.rows.map((run) => run.id);
    const steps = await pool.query(
      `SELECT s.run_id AS "runId", s.position, s.command, s.status, s.category,
              s.exit_code AS "exitCode", s.duration_ms AS "durationMs", s.output, s.progress,
              s.started_at AS "startedAt"
         FROM test_run_steps s
         JOIN test_runs r ON r.id = s.run_id
        WHERE r.project_slug = $1
          AND r.id = ANY($2::uuid[])
        ORDER BY r.started_at DESC, s.position`,
      [slug, ids],
    );
    // Zählung je Kategorie und Status, damit die Übersicht ohne die Einzeltests auskommt
    const counts = await pool.query<{ runId: string; category: string; status: string; count: number }>(
      `SELECT run_id AS "runId", category, status, count(*)::int AS count
         FROM test_cases
        WHERE run_id = ANY($1::uuid[])
        GROUP BY run_id, category, status`,
      [ids],
    );
    const media = await pool.query<{ runId: string; count: number }>(
      `SELECT run_id AS "runId", count(*)::int AS count FROM test_media WHERE run_id = ANY($1::uuid[]) GROUP BY run_id`,
      [ids],
    );
    response.json({
      runs: runs.rows.map((run) => {
        const summary: Record<string, Record<string, number>> = {};
        for (const row of counts.rows.filter((row) => row.runId === run.id)) {
          (summary[row.category] ??= {})[row.status] = row.count;
        }
        return {
          ...run,
          steps: steps.rows
            .filter((step) => step.runId === run.id)
            .map((step) => ({ ...step, category: step.category ?? categoryOfCommand(step.command) })),
          summary,
          mediaCount: media.rows.find((row) => row.runId === run.id)?.count ?? 0,
        };
      }),
    });
  });

  // Live-Ansicht: der neueste laufende Testlauf mit seinen Schritten (Fortschritt, Laufzeit, Ende der Ausgabe).
  // Klein gehalten, weil die Oberfläche ihn alle paar Sekunden abfragt; null, wenn gerade nichts läuft.
  app.get('/projects/:slug/test-runs/live', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Invalid project slug.' });
      return;
    }
    const run = (
      await pool.query(
        `SELECT id, status, trigger, branch, started_at AS "startedAt", NOW() AS "now"
           FROM test_runs WHERE project_slug = $1 AND status = 'running'
          ORDER BY started_at DESC LIMIT 1`,
        [slug],
      )
    ).rows[0];
    if (!run) {
      response.set('Cache-Control', 'no-store').json({ run: null });
      return;
    }
    const steps = await pool.query(
      `SELECT position, command, status, category, progress, duration_ms AS "durationMs", started_at AS "startedAt",
              CASE WHEN status = 'running' THEN right(output, 2000) ELSE '' END AS output
         FROM test_run_steps WHERE run_id = $1 ORDER BY position`,
      [run.id],
    );
    response.set('Cache-Control', 'no-store').json({ run: { ...run, steps: steps.rows } });
  });

  app.get('/projects/:slug/test-runs/:id/cases', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug || !isUuid(request.params.id)) {
      response.status(400).json({ message: 'Invalid test run.' });
      return;
    }
    const cases = await pool.query(
      `SELECT c.id, c.position, c.category, c.title, c.file, c.device, c.status,
              c.duration_ms AS "durationMs", c.errors
         FROM test_cases c
         JOIN test_runs r ON r.id = c.run_id
        WHERE r.project_slug = $1 AND r.id = $2
        ORDER BY c.position`,
      [slug, request.params.id],
    );
    const media = await pool.query<{ id: string; caseId: string; name: string; mime: string; size: number }>(
      `SELECT id, case_id AS "caseId", name, mime, size FROM test_media WHERE run_id = $1 ORDER BY created_at, id`,
      [request.params.id],
    );
    response.json({
      cases: cases.rows.map((testCase) => ({
        ...testCase,
        media: media.rows
          .filter((file) => file.caseId === testCase.id)
          .map(({ id, name, mime, size }) => ({ id, name, mime, size })),
      })),
    });
  });

  // Screenshots und Videos; Videos mit Range-Anfragen, damit der Browser darin springen kann.
  app.get('/test-media/:id', async (request, response) => {
    const result = isUuid(request.params.id)
      ? await pool.query<{ mime: string; data: Buffer }>(`SELECT mime, data FROM test_media WHERE id = $1`, [
          request.params.id,
        ])
      : { rows: [] };
    const row = result.rows[0];
    if (!row) {
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    response.set({
      'Content-Type': row.mime,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Cache-Control': 'private, max-age=86400',
      'Accept-Ranges': 'bytes',
    });
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.get('range') ?? '');
    if (!range) {
      response.send(row.data);
      return;
    }
    const size = row.data.length;
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      response.status(416).set('Content-Range', `bytes */${size}`).end();
      return;
    }
    response.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`);
    response.send(row.data.subarray(start, end + 1));
  });
}
