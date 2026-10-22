import type { Router } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
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
export function registerVisionaryRoutes(app: Router, pool: Pool): void {
  app.post(
    '/projects/:slug/ideation/visionary',
    access({ role: 'plan', tenant: 'project' }),
    async (request, response) => {
      const slug = parseProjectSlug(request.params.slug ?? '');
      if (!slug) {
        response.status(400).json({ message: 'Ungültiges Projekt.' });
        return;
      }
      const project = await pool.query('SELECT 1 FROM projects WHERE slug = $1', [slug]);
      if (!project.rowCount) {
        response.status(404).json({ message: 'Projekt nicht gefunden.' });
        return;
      }
      const principal = response.locals.principal as Principal | undefined;
      // Kommentar aus der Bestätigung: Schwerpunkt für diesen Lauf.
      const body = request.body as { comment?: unknown; focus?: unknown } | undefined;
      const focus =
        typeof body?.comment === 'string' ? body.comment : typeof body?.focus === 'string' ? body.focus : null;
      const id = await requestVisionaryRun(pool, slug, principal?.displayName || principal?.username || 'Nutzer', {
        focus,
      });
      const run = await latestRun(pool, slug);
      if (!id) {
        response.status(409).json({ message: 'Für dieses Projekt läuft bereits ein Visionär-Lauf.', run });
        return;
      }
      response.status(202).json({ run });
    },
  );

  app.get('/projects/:slug/ideation/visionary', access({ tenant: 'project' }), async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Ungültiges Projekt.' });
      return;
    }
    response.json({ run: await latestRun(pool, slug) });
  });

  app.post(
    '/projects/:slug/ideation/visionary/cancel',
    access({ role: 'plan', tenant: 'project' }),
    async (request, response) => {
      const slug = parseProjectSlug(request.params.slug ?? '');
      if (!slug) {
        response.status(400).json({ message: 'Ungültiges Projekt.' });
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
    },
  );
}
