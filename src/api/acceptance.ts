import type { Express } from 'express';
import type { Pool } from 'pg';
import { DEFAULT_DEFINITION_OF_DONE, DEFAULT_DEFINITION_OF_READY } from '../runner/acceptance.js';
import { parseProjectSlug } from '../core/validation.js';

/** Abnahme je Auftrag (Akzeptanzkriterien und DoD-Punkte mit Status) sowie die Standard-Definitionen. */
export function registerAcceptanceRoutes(app: Express, pool: Pool): void {
  app.get('/api/projects/:slug/acceptance', async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
      const checks = (
        await pool.query(
          `SELECT a.development_id AS "developmentId", a.kind, a.position, a.text, a.status, a.note, a.checked_at AS "checkedAt"
             FROM acceptance_checks a JOIN development_items d ON d.id = a.development_id
            WHERE d.project_slug = $1 ORDER BY a.development_id, a.kind, a.position`,
          [slug],
        )
      ).rows;
      response.json({
        checks,
        defaults: { definitionOfReady: DEFAULT_DEFINITION_OF_READY, definitionOfDone: DEFAULT_DEFINITION_OF_DONE },
      });
    } catch (error) {
      next(error);
    }
  });
}
