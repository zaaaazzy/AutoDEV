import type { Router } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import { COMPLETE_COVERAGE_SQL, COVERAGE_AREA_KEYS, type CoverageAreaKey } from '../core/coverage-areas.js';
import { parseProjectSlug } from '../core/validation.js';
import { CoverageValidationError, saveCoverage, validateCoverage } from '../runner/coverage.js';

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
export function coverageTrend(rows: CoverageTrendRow[]): { area: CoverageAreaKey; points: CoverageTrendPoint[] }[] {
  const toPoint = (row: CoverageTrendRow): CoverageTrendPoint => ({
    reportId: row.reportId,
    date: new Date(row.createdAt).toISOString(),
    lines: row.lines === null ? null : Number(row.lines),
    branches: row.branches === null ? null : Number(row.branches),
    tests: Number(row.tests),
  });
  return COVERAGE_AREA_KEYS.map((area) => ({
    area,
    points: rows
      .filter((row) => row.area === area)
      .map(toPoint)
      .sort((a, b) => a.date.localeCompare(b.date)),
  }));
}

/** Höchstens so viele Punkte je Bereich im Verlauf (die neuesten). */
export const HISTORY_LIMIT = 60;

type Queryable = Pick<Pool, 'query'>;

const order = (area: string): number => COVERAGE_AREA_KEYS.indexOf(area as (typeof COVERAGE_AREA_KEYS)[number]);

/**
 * Übersicht: letzter Bericht (Zusammenfassung, Auftrag) und je Bereichsschlüssel höchstens eine Zeile mit dem neuesten
 * vollständigen Lauf und dessen Datum. Hat ein Schlüssel keinen vollständigen Lauf, steht sein neuester Eintrag ohne
 * Prozentwerte da (`complete: false`, angezeigt als „–“).
 */
export async function coverageOverview(pool: Queryable, slug: string) {
  const report = (
    await pool.query<{
      id: string;
      summary: string;
      createdAt: string;
      developmentId: string | null;
      orderTitle: string | null;
    }>(
      `SELECT r.id, r.summary, r.created_at AS "createdAt", r.development_id AS "developmentId",
              d.title AS "orderTitle"
         FROM test_coverage_reports r LEFT JOIN development_items d ON d.id = r.development_id
        WHERE r.project_slug = $1 ORDER BY r.created_at DESC LIMIT 1`,
      [slug],
    )
  ).rows[0];
  if (!report) return null;
  const rows = (
    await pool.query(
      `SELECT DISTINCT ON (a.area) a.area, a.unit_tests AS unit, a.component_tests AS component,
              a.integration_tests AS integration, a.e2e_tests AS e2e, a.passed, a.failed,
              a.lines, a.statements, a.branches, a.functions, r.created_at AS "createdAt",
              (${COMPLETE_COVERAGE_SQL}) AS complete
         FROM test_coverage_areas a JOIN test_coverage_reports r ON r.id = a.report_id
        WHERE r.project_slug = $1
        ORDER BY a.area, (${COMPLETE_COVERAGE_SQL}) DESC, r.created_at DESC`,
      [slug],
    )
  ).rows as { area: string; complete: boolean; [key: string]: unknown }[];
  const areas = rows
    .map((row) => (row.complete ? row : { ...row, lines: null, statements: null, branches: null, functions: null }))
    .sort((a, b) => order(a.area) - order(b.area));
  return { ...report, areas };
}

/** Verlauf der Zeilenabdeckung je Bereichsschlüssel: vollständige Läufe, je Schlüssel die neuesten, aufsteigend. */
export async function coverageHistory(pool: Queryable, slug: string) {
  const rows = (
    await pool.query<{ area: string; lines: number; createdAt: string }>(
      `SELECT area, lines, "createdAt" FROM (
         SELECT a.area, a.lines, r.created_at AS "createdAt",
                row_number() OVER (PARTITION BY a.area ORDER BY r.created_at DESC) AS rank
           FROM test_coverage_areas a JOIN test_coverage_reports r ON r.id = a.report_id
          WHERE r.project_slug = $1 AND ${COMPLETE_COVERAGE_SQL}
       ) h
        WHERE rank <= $2 ORDER BY area, "createdAt"`,
      [slug, HISTORY_LIMIT],
    )
  ).rows;
  return rows.sort((a, b) => order(a.area) - order(b.area));
}

/**
 * Abdeckungsberichte: Übersicht je Bereich mit letztem Bericht (Dashboard-Kachel), Verlauf der Zeilenabdeckung,
 * Zeitreihe je Bereich (Statistik) und Schreibweg.
 */
export function registerCoverageRoutes(app: Router, pool: Pool): void {
  app.get('/projects/:slug/coverage', access({ tenant: 'project' }), async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
      response.json({ report: await coverageOverview(pool, slug) });
    } catch (error) {
      next(error);
    }
  });
  app.get('/projects/:slug/coverage/history', access({ tenant: 'project' }), async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
      response.json({ history: await coverageHistory(pool, slug) });
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
          [slug, [...COVERAGE_AREA_KEYS], TREND_REPORTS],
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
