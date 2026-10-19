import type { Router } from 'express';
import type { Pool } from 'pg';
import { parseProjectSlug } from '../core/validation.js';

/** Letzter Abdeckungsbericht des Testers mit den Werten je Bereich. */
export function registerCoverageRoutes(app: Router, pool: Pool): void {
  app.get('/projects/:slug/coverage', async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
      const report = (
        await pool.query(
          `SELECT r.id, r.summary, r.created_at AS "createdAt", r.development_id AS "developmentId",
                  d.title AS "orderTitle"
             FROM test_coverage_reports r LEFT JOIN development_items d ON d.id = r.development_id
            WHERE r.project_slug = $1 ORDER BY r.created_at DESC LIMIT 1`,
          [slug],
        )
      ).rows[0];
      if (!report) return void response.json({ report: null });
      const areas = (
        await pool.query(
          `SELECT area, unit_tests AS unit, component_tests AS component, integration_tests AS integration,
                  e2e_tests AS e2e, passed, failed, lines, statements, branches, functions
             FROM test_coverage_areas WHERE report_id = $1 ORDER BY area`,
          [report.id],
        )
      ).rows;
      response.json({ report: { ...report, areas } });
    } catch (error) {
      next(error);
    }
  });
}
