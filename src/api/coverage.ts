import type { Router } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import { parseProjectSlug } from '../core/validation.js';
import {
  COVERAGE_AREAS,
  type CoverageAreaName,
  CoverageValidationError,
  saveCoverage,
  validateCoverage,
} from '../runner/coverage.js';

/** Höchstens so viele Berichte je Zeitreihe (die neuesten). */
const TREND_REPORTS = 200;

export interface CoverageTrendPoint {
  reportId: string;
  date: string;
  /** null = im Altbestand nicht gemeldet: Lücke in der Zeitreihe, nicht 0 %. */
  lines: number | null;
  branches: number | null;
  tests: number;
}

export interface CoverageTrendRow {
  reportId: string;
  createdAt: Date | string;
  area: string;
  lines: number | null;
  branches: number | null;
  tests: number | string;
}

/**
 * Zeitreihe je fester Bereich, nach Datum aufsteigend. Zeilen mit anderen Bereichsnamen (Altbestand ohne Zuordnung)
 * werden ausgeblendet; fehlende Prozentwerte bleiben null.
 */
export function coverageTrend(rows: CoverageTrendRow[]): { area: CoverageAreaName; points: CoverageTrendPoint[] }[] {
  const toPoint = (row: CoverageTrendRow): CoverageTrendPoint => ({
    reportId: row.reportId,
    date: new Date(row.createdAt).toISOString(),
    lines: row.lines === null ? null : Number(row.lines),
    branches: row.branches === null ? null : Number(row.branches),
    tests: Number(row.tests),
  });
  return COVERAGE_AREAS.map((area) => ({
    area,
    points: rows
      .filter((row) => row.area === area)
      .map(toPoint)
      .sort((a, b) => a.date.localeCompare(b.date)),
  }));
}

/** Abdeckungsberichte: letzter Bericht (Dashboard-Kachel), Zeitreihe je Bereich (Statistik) und Schreibweg. */
export function registerCoverageRoutes(app: Router, pool: Pool): void {
  app.get('/projects/:slug/coverage', access({ tenant: 'project' }), async (request, response, next) => {
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

  app.get('/projects/:slug/coverage/trend', access({ tenant: 'project' }), async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
      const rows = (
        await pool.query<CoverageTrendRow>(
          `SELECT r.id AS "reportId", r.created_at AS "createdAt", a.area, a.lines, a.branches,
                  a.unit_tests + a.component_tests + a.integration_tests + a.e2e_tests AS tests
             FROM (SELECT id, created_at FROM test_coverage_reports WHERE project_slug = $1
                    ORDER BY created_at DESC LIMIT $3) r
             JOIN test_coverage_areas a ON a.report_id = r.id
            WHERE a.area = ANY($2::text[])
            ORDER BY r.created_at`,
          [slug, [...COVERAGE_AREAS], TREND_REPORTS],
        )
      ).rows;
      response.json({ areas: coverageTrend(rows) });
    } catch (error) {
      next(error);
    }
  });

  // Schreibweg (z. B. CI oder ein externer Tester): derselbe Validator wie im Runner; ungültig → 400, nichts gespeichert.
  app.post('/projects/:slug/coverage', access({ role: 'run', tenant: 'project' }), async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
      const checked = validateCoverage(request.body);
      if (!checked.ok) {
        return void response
          .status(400)
          .json({ message: `Testabdeckung abgelehnt: ${checked.errors.join(' ')}`, errors: checked.errors });
      }
      const id = await saveCoverage(pool, slug, null, checked.report);
      response.status(201).json({ id });
    } catch (error) {
      if (error instanceof CoverageValidationError) {
        return void response.status(400).json({ message: error.message, errors: error.errors });
      }
      next(error);
    }
  });
}
