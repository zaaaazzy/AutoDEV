import type { Response, Router } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import { isRecord, isUuid } from '../core/validation.js';
import { parsePreviewPages, parseVisualSettings, previewUrlError } from '../runner/visual-check.js';
import type { Principal } from './roles.js';

/** Spalten der visuellen Prüfung in den Projekt-Einstellungen. */

/** Prüft Vorschau-Adresse, Seiten und Einstellungen; liefert Spalten und Werte oder den Fehler. */
export function parsePreviewSettings(body: Record<string, unknown>): [string, unknown][] | string {
  const sets: [string, unknown][] = [];
  if (body.previewUrl !== undefined) {
    const url = typeof body.previewUrl === 'string' ? body.previewUrl.trim() : body.previewUrl === null ? '' : null;
    if (url === null) return 'Ungültige Vorschau-Adresse.';
    const error = url ? previewUrlError(url) : null;
    if (error) return error;
    sets.push(['preview_url', url || null]);
  }
  if (body.previewPages !== undefined) {
    const pages = parsePreviewPages(body.previewPages);
    if (typeof pages === 'string') return pages;
    sets.push(['preview_pages', JSON.stringify(pages)]);
  }
  if (body.visualSettings !== undefined) {
    const settings = parseVisualSettings(body.visualSettings);
    if (typeof settings === 'string') return settings;
    sets.push(['visual_settings', JSON.stringify(settings)]);
  }
  return sets;
}

export interface VisualSnapshotInfo {
  id: string;
  developmentId: string | null;
  page: string;
  device: 'desktop' | 'mobile';
  kind: 'shot' | 'diff';
  diffPercent: number | null;
  baseId: string | null;
  size: number;
  createdAt: string;
}

/** Aufnahmen und Diffs eines Auftrags samt ihren Vorher-Ständen (die aus früheren Aufträgen stammen können). */
export async function loadOrderSnapshots(pool: Pool, developmentId: string): Promise<VisualSnapshotInfo[]> {
  return (
    await pool.query<VisualSnapshotInfo>(
      `WITH own AS (SELECT * FROM visual_snapshots WHERE development_id = $1)
       SELECT s.id, s.development_id AS "developmentId", s.page, s.device, s.kind, s.diff_percent AS "diffPercent",
              s.base_id AS "baseId", octet_length(s.data) AS size, s.created_at AS "createdAt"
         FROM visual_snapshots s
        WHERE s.id IN (SELECT id FROM own UNION SELECT base_id FROM own WHERE base_id IS NOT NULL)
        ORDER BY s.page, s.device, s.created_at`,
      [developmentId],
    )
  ).rows;
}

const principalName = (response: Response): string => {
  const principal = response.locals.principal as Principal | undefined;
  return (principal?.displayName || principal?.username || 'Nutzer').slice(0, 80);
};

/**
 * Reiter „Ansicht“: Snapshots eines Auftrags, Bildauslieferung (wie Anhänge, Mandantenprüfung über tenancy.ts:
 * /api/visual-snapshots/<id> gehört zum Projekt des Snapshots) und die optische Freigabe.
 */
export function registerVisualRoutes(app: Router, pool: Pool): void {
  app.get('/development/:id/visual', access({ tenant: 'development' }), async (request, response, next) => {
    try {
      if (!isUuid(request.params.id)) return void response.status(404).json({ message: 'Auftrag nicht gefunden.' });
      const order = (
        await pool.query<{ approvedAt: string | null; approvedBy: string | null }>(
          `SELECT visual_approved_at AS "approvedAt", visual_approved_by AS "approvedBy"
             FROM development_items WHERE id = $1`,
          [request.params.id],
        )
      ).rows[0];
      if (!order) return void response.status(404).json({ message: 'Auftrag nicht gefunden.' });
      response.json({ snapshots: await loadOrderSnapshots(pool, request.params.id), approval: order });
    } catch (error) {
      next(error);
    }
  });

  app.get('/visual-snapshots/:id', access({ tenant: 'visual-snapshots' }), async (request, response, next) => {
    try {
      const row = isUuid(request.params.id)
        ? (await pool.query<{ data: Buffer }>('SELECT data FROM visual_snapshots WHERE id = $1', [request.params.id]))
            .rows[0]
        : undefined;
      if (!row) return void response.status(404).json({ message: 'Nicht gefunden.' });
      response.set({
        'Content-Type': 'image/png',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
        'Cache-Control': 'private, max-age=3600',
      });
      response.send(row.data);
    } catch (error) {
      next(error);
    }
  });

  // „Optisch freigeben“ (approved: true) oder die Freigabe zurücknehmen (approved: false).
  app.post(
    '/development/:id/visual/approve',
    access({ role: 'run', tenant: 'development' }),
    async (request, response, next) => {
      try {
        const body = isRecord(request.body) ? request.body : {};
        const approved = body.approved !== false;
        if (!isUuid(request.params.id)) return void response.status(404).json({ message: 'Auftrag nicht gefunden.' });
        const row = (
          await pool.query<{ approvedAt: string | null; approvedBy: string | null }>(
            `UPDATE development_items
              SET visual_approved_at = CASE WHEN $2::boolean THEN NOW() END,
                  visual_approved_by = CASE WHEN $2::boolean THEN $3::text END
            WHERE id = $1
            RETURNING visual_approved_at AS "approvedAt", visual_approved_by AS "approvedBy"`,
            [request.params.id, approved, principalName(response)],
          )
        ).rows[0];
        if (!row) return void response.status(404).json({ message: 'Auftrag nicht gefunden.' });
        response.json({ approval: row });
      } catch (error) {
        next(error);
      }
    },
  );
}
