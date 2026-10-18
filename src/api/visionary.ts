import type { Express } from 'express';
import type { Pool } from 'pg';
import { requestVisionaryRun } from '../agent/visionary.js';
import { parseProjectSlug } from '../core/validation.js';
import type { Principal } from './roles.js';

export const VISIONARY_RUN_COLUMNS = `id, status, progress, created_count AS "createdCount",
  discarded_count AS "discardedCount", error, requested_by AS "requestedBy", requested_at AS "requestedAt",
  started_at AS "startedAt", finished_at AS "finishedAt"`;

const latestRun = async (pool: Pool, slug: string): Promise<Record<string, unknown> | null> =>
  (
    await pool.query(
      `SELECT ${VISIONARY_RUN_COLUMNS} FROM visionary_runs WHERE project_slug = $1 ORDER BY requested_at DESC LIMIT 1`,
      [slug],
    )
  ).rows[0] ?? null;

/** Visionär: Lauf anfragen (der Worker arbeitet ihn ab), Fortschritt abfragen, Lauf abbrechen. */
export function registerVisionaryRoutes(app: Express, pool: Pool): void {
  app.post('/api/projects/:slug/ideation/visionary', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Invalid project slug.' });
      return;
    }
    const project = await pool.query('SELECT 1 FROM projects WHERE slug = $1', [slug]);
    if (!project.rowCount) {
      response.status(404).json({ message: 'Projekt nicht gefunden.' });
      return;
    }
    const principal = response.locals.principal as Principal | undefined;
    const id = await requestVisionaryRun(pool, slug, principal?.displayName || principal?.username || 'Nutzer');
    const run = await latestRun(pool, slug);
    if (!id) {
      response.status(409).json({ message: 'Für dieses Projekt läuft bereits ein Visionär-Lauf.', run });
      return;
    }
    response.status(202).json({ run });
  });

  app.get('/api/projects/:slug/ideation/visionary', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Invalid project slug.' });
      return;
    }
    response.json({ run: await latestRun(pool, slug) });
  });

  app.post('/api/projects/:slug/ideation/visionary/cancel', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Invalid project slug.' });
      return;
    }
    // Der Worker sieht den Status beim nächsten Abfragen und beendet den Agent; angelegt wird dann nichts.
    const result = await pool.query(
      `UPDATE visionary_runs SET status = 'cancelled', finished_at = NOW(), progress = NULL
        WHERE project_slug = $1 AND status IN ('requested', 'running') RETURNING id`,
      [slug],
    );
    if (!result.rowCount) {
      response.status(409).json({ message: 'Es läuft kein Visionär-Lauf.', run: await latestRun(pool, slug) });
      return;
    }
    response.json({ run: await latestRun(pool, slug) });
  });
}
