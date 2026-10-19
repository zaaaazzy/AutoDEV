import type { Express } from 'express';
import type { Pool } from 'pg';
import { DEVELOPMENT_STATUS } from '../core/status.js';
import { isUuid, parseProjectSlug } from '../core/validation.js';
import { DEV_COLUMNS, retryComment } from './development.js';

/**
 * Review-Freigabe: Ein fertiger Auftrag wartet (Status review), bis ein Mensch ihn in der Review-Instanz angesehen hat.
 * Freigeben merkt die Freigabe vor; gemergt wird vom Worker auf dem Host (dort liegt das Git-Repository).
 */
export function registerReviewRoutes(app: Express, pool: Pool): void {
  app.get('/api/projects/:slug/review', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug);
    if (!slug) {
      response.status(404).json({ message: 'Projekt nicht gefunden.' });
      return;
    }
    const project = await pool.query<{ mode: string; url: string | null; configured: boolean }>(
      `SELECT review_mode AS mode, review_url AS url, review_command IS NOT NULL AS configured FROM projects WHERE slug = $1`,
      [slug],
    );
    if (!project.rows[0]) {
      response.status(404).json({ message: 'Projekt nicht gefunden.' });
      return;
    }
    const instance = await pool.query(
      `SELECT development_id AS "developmentId", requested_id AS "requestedId", status, message, updated_at AS "updatedAt"
         FROM review_instances WHERE project_slug = $1`,
      [slug],
    );
    const waiting = await pool.query(
      `SELECT id, title, review_since AS "reviewSince", review_approved_at AS "reviewApprovedAt"
         FROM development_items WHERE project_slug = $1 AND status = '${DEVELOPMENT_STATUS.approval}'
        ORDER BY review_since NULLS LAST`,
      [slug],
    );
    response.json({
      mode: project.rows[0].mode,
      url: project.rows[0].url,
      configured: project.rows[0].configured,
      instance: instance.rows[0] ?? null,
      waiting: waiting.rows,
    });
  });

  app.post('/api/development/:id/approve', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Auftrag nicht gefunden.' });
      return;
    }
    const result = await pool.query(
      `UPDATE development_items SET review_approved_at = COALESCE(review_approved_at, NOW()), updated_at = NOW()
        WHERE id = $1 AND status = '${DEVELOPMENT_STATUS.approval}' RETURNING ${DEV_COLUMNS}, project_slug AS "projectSlug"`,
      [request.params.id],
    );
    const item = result.rows[0] as { projectSlug: string } | undefined;
    if (!item) {
      response.status(409).json({ message: 'Nur Aufträge, die auf die Freigabe warten, können freigegeben werden.' });
      return;
    }
    // Worker sofort wecken: er mergt zwischen zwei Aufträgen.
    await pool.query(`SELECT pg_notify('devlog_work', $1)`, [item.projectSlug]).catch(() => undefined);
    response.json({ item });
  });

  app.post('/api/development/:id/review-reject', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Auftrag nicht gefunden.' });
      return;
    }
    const comment = retryComment(request.body);
    if (!comment) {
      response.status(400).json({ message: 'Bitte kurz beschreiben, was nicht passt – das geht an den Entwickler.' });
      return;
    }
    // Zurück an die Agents: der Auftrag läuft erneut auf seinem Branch, die Rückmeldung steht in der Beschreibung.
    const result = await pool.query(
      `UPDATE development_items d SET status = '${DEVELOPMENT_STATUS.planned}', auto_run = TRUE, review_approved_at = NULL,
              review_since = NULL, failure = NULL, action_todo = NULL, budget_since = NOW(), updated_at = NOW(),
              description = COALESCE(d.description, '') || E'\\n\\n## Rückmeldung aus der Review-Freigabe (' ||
                to_char(NOW(), 'DD.MM.YYYY HH24:MI') || E')\\n' || $2::text
        WHERE d.id = $1 AND d.status = '${DEVELOPMENT_STATUS.approval}' AND d.review_approved_at IS NULL
        RETURNING ${DEV_COLUMNS}`,
      [request.params.id, comment],
    );
    if (!result.rows[0]) {
      response
        .status(409)
        .json({ message: 'Nur Aufträge, die noch auf die Freigabe warten, können zurückgewiesen werden.' });
      return;
    }
    response.json({ item: result.rows[0] });
  });

  app.post('/api/development/:id/show-review', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Auftrag nicht gefunden.' });
      return;
    }
    const item = await pool.query<{ slug: string }>(
      `SELECT project_slug AS slug FROM development_items WHERE id = $1 AND status = '${DEVELOPMENT_STATUS.approval}'`,
      [request.params.id],
    );
    const slug = item.rows[0]?.slug;
    if (!slug) {
      response.status(409).json({ message: 'Der Auftrag wartet nicht auf eine Freigabe.' });
      return;
    }
    // Gewünschten Auftrag merken; nach einem Fehlstart (gleicher Auftrag) erzwingt das Zurücksetzen einen Neustart.
    await pool.query(
      `INSERT INTO review_instances (project_slug, requested_id, status) VALUES ($1, $2, 'stopped')
       ON CONFLICT (project_slug) DO UPDATE SET requested_id = $2, updated_at = NOW(),
         development_id = CASE WHEN review_instances.status = 'failed' THEN NULL ELSE review_instances.development_id END,
         status = CASE WHEN review_instances.status = 'failed' THEN 'stopped' ELSE review_instances.status END`,
      [slug, request.params.id],
    );
    response.json({ ok: true });
  });
}
