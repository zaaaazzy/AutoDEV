import type { Pool } from 'pg';

/** Ab dieser Zeilenabdeckung gilt ein Bereich als ausreichend getestet. */
export const COVERAGE_TARGET = 75;

const MARKER = /^@@COVERAGE\s+(\{.*\})\s*$/gm;

/** Anweisung an den Tester: Abdeckung messen, Lücken mit Tests schließen, Ergebnis maschinenlesbar melden. */
export const COVERAGE_INSTRUCTIONS = `## Testabdeckung (Pflicht für den Tester)
1. Ermittle pro Bereich des Projekts (z. B. Frontend, Backend, Contracts/Shared) die Testabdeckung. Gibt es ein npm-Skript \`test:coverage\`, nutze zuerst \`npm run test:coverage\`; sonst die Werkzeuge des Projekts (z. B. \`ng test --watch=false --coverage\`, \`tsx --test --experimental-test-coverage\`, \`vitest --coverage\`). Fehlt ein Coverage-Werkzeug, richte es als devDependency ein.
2. Zähle die Testfälle je Bereich nach Testart: Unit-Tests (isolierte Funktionen/Services), Komponententests (UI-Komponenten mit TestBed o. Ä.), Integrationstests (mehrere Schichten, z. B. HTTP-Route mit Datenbank) und End-to-End-Tests (E2E, Browser über die ganze Anwendung).
3. Liegt die Zeilenabdeckung eines Bereichs unter ${COVERAGE_TARGET} % oder ist der geänderte Code des Auftrags ungetestet, schreibe gezielt Tests für die ungetesteten, fachlich wichtigen Pfade und miss danach erneut.
4. Beende deine Antwort mit genau einer Zeile in diesem Format (gültiges JSON in einer Zeile, Prozentwerte als Zahl, unbekannt = null):
@@COVERAGE {"summary":"<kurze Zusammenfassung in Markdown, inkl. neu geschriebener Tests und verbleibender Lücken>","areas":[{"area":"Frontend","unit":0,"component":0,"integration":0,"e2e":0,"passed":0,"failed":0,"lines":0,"statements":0,"branches":0,"functions":0}]}`;

export interface CoverageArea {
  area: string;
  unit: number;
  component: number;
  integration: number;
  e2e: number;
  passed: number;
  failed: number;
  lines: number | null;
  statements: number | null;
  branches: number | null;
  functions: number | null;
}

export interface CoverageReport {
  summary: string;
  areas: CoverageArea[];
}

const count = (value: unknown): number => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0);
const percent = (value: unknown): number | null =>
  value === null || value === undefined || value === '' || !Number.isFinite(Number(value))
    ? null
    : Math.min(100, Math.max(0, Number(value)));

/** Liest den @@COVERAGE-Block des Testers; null, wenn keiner oder kein gültiger vorhanden ist. */
export function parseCoverage(output: string): CoverageReport | null {
  // Bei mehreren Blöcken zählt der letzte (Messung nach dem Schreiben neuer Tests).
  const json = [...output.matchAll(MARKER)].at(-1)?.[1];
  if (!json) return null;
  try {
    const data = JSON.parse(json) as { summary?: unknown; areas?: unknown };
    if (!Array.isArray(data.areas)) return null;
    const areas = data.areas
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .filter((entry) => typeof entry.area === 'string' && entry.area.trim())
      .map((entry) => ({
        area: String(entry.area).trim().slice(0, 60),
        unit: count(entry.unit),
        component: count(entry.component),
        integration: count(entry.integration),
        e2e: count(entry.e2e),
        passed: count(entry.passed),
        failed: count(entry.failed),
        lines: percent(entry.lines),
        statements: percent(entry.statements),
        branches: percent(entry.branches),
        functions: percent(entry.functions),
      }));
    if (!areas.length) return null;
    return { summary: typeof data.summary === 'string' ? data.summary.slice(0, 8000) : '', areas };
  } catch {
    return null;
  }
}

/** Entfernt den Block aus der angezeigten Ausgabe. */
export function stripCoverage(output: string): string {
  return output.replace(MARKER, '').trimEnd();
}

/** Speichert den Bericht in einer Transaktion; doppelt gemeldete Bereiche zählen einmal (der erste gilt). */
export async function saveCoverage(
  pool: Pool,
  project: string,
  developmentId: string | null,
  report: CoverageReport,
): Promise<void> {
  const seen = new Set<string>();
  const areas = report.areas.filter((area) => {
    const key = area.area.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = (
      await client.query<{ id: string }>(
        `INSERT INTO test_coverage_reports (project_slug, development_id, summary) VALUES ($1, $2, $3) RETURNING id`,
        [project, developmentId, report.summary],
      )
    ).rows[0]?.id;
    for (const area of areas) {
      await client.query(
        `INSERT INTO test_coverage_areas (report_id, area, unit_tests, component_tests, integration_tests, e2e_tests,
                                          passed, failed, lines, statements, branches, functions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          id,
          area.area,
          area.unit,
          area.component,
          area.integration,
          area.e2e,
          area.passed,
          area.failed,
          area.lines,
          area.statements,
          area.branches,
          area.functions,
        ],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
