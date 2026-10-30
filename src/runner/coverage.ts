import type { Pool } from 'pg';
import { COVERAGE_AREA_KEYS, type CoverageAreaKey, isCoverageAreaKey } from '../core/coverage-areas.js';

/** Ab dieser Zeilenabdeckung gilt ein Bereich als ausreichend getestet. */
export const COVERAGE_TARGET = 75;

const MARKER = /^@@COVERAGE\s+(\{.*\})\s*$/gm;

const KEYS = COVERAGE_AREA_KEYS.join(', ');

/** Anweisung an den Tester: Abdeckung messen, Lücken mit Tests schließen, Ergebnis maschinenlesbar melden. */
export const COVERAGE_INSTRUCTIONS = `## Testabdeckung (AIdeation misst nach deinem Schritt zusätzlich selbst)
1. Ermittle pro Bereich des Projekts die Testabdeckung. Gültige Bereichsnamen sind genau: ${COVERAGE_AREA_KEYS.map((area) => `\`${area}\``).join(', ')} („auftrag“ = der vom Auftrag geänderte Code, „gesamt“ = das ganze Projekt). Andere Namen werden abgelehnt. Gibt es ein npm-Skript \`test:coverage\`, nutze zuerst \`npm run test:coverage\`; sonst die Werkzeuge des Projekts (z. B. \`ng test --watch=false --coverage\`, \`tsx --test --experimental-test-coverage\`, \`vitest --coverage\`). Fehlt ein Coverage-Werkzeug, richte es als devDependency ein.
2. Zähle die Testfälle je Bereich nach Testart: Unit-Tests (isolierte Funktionen/Services), Komponententests (UI-Komponenten mit TestBed o. Ä.), Integrationstests (mehrere Schichten, z. B. HTTP-Route mit Datenbank) und End-to-End-Tests (E2E, Browser über die ganze Anwendung).
3. Liegt die Zeilenabdeckung eines Bereichs unter ${COVERAGE_TARGET} % oder ist der geänderte Code des Auftrags ungetestet, schreibe gezielt Tests für die ungetesteten, fachlich wichtigen Pfade und miss danach erneut.
4. Melde nur Bereiche, die du gemessen hast. Für jeden gemeldeten Bereich sind \`lines\` und \`branches\` Pflicht (Zahl von 0 bis 100). \`null\` ist nicht erlaubt, auch nicht für unbekannte Werte. Bereiche ohne Tests (Summe aus unit, component, integration und e2e gleich 0) sind nicht erlaubt. Ein ungültiger Block wird vollständig verworfen. Lässt sich die Abdeckung nicht messen (Werkzeug fehlt, Befehl vom Wächter gesperrt), lass den Bereich weg oder den ganzen Block; das ist kein Grund, die Abnahme abzulehnen – AIdeation misst nach deinem Schritt selbst.
5. Beende deine Antwort mit genau einer Zeile in diesem Format (gültiges JSON in einer Zeile, Prozentwerte als Zahl):
@@COVERAGE {"summary":"<kurze Zusammenfassung in Markdown, inkl. neu geschriebener Tests und verbleibender Lücken>","areas":[{"area":"frontend","unit":12,"component":4,"integration":0,"e2e":0,"passed":16,"failed":0,"lines":81.4,"statements":80.9,"branches":62,"functions":74.5}]}`;

export interface CoverageArea {
  area: CoverageAreaKey;
  unit: number;
  component: number;
  integration: number;
  e2e: number;
  passed: number;
  failed: number;
  lines: number;
  statements: number | null;
  branches: number;
  functions: number | null;
}

export interface CoverageReport {
  summary: string;
  areas: CoverageArea[];
}

/** Ergebnis der Prüfung: gültiger Bericht oder die Gründe der Ablehnung (lesbar, je Bereich). */
export type CoverageValidation = { ok: true; report: CoverageReport } | { ok: false; errors: string[] };

const isPercent = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * Gemeinsamer Validator für jede Meldung (Tester-Block, Messung durch AIdeation, HTTP-Schreibweg): Bereich aus der
 * festen Liste, Zeilen- und Zweigwert als Zahl 0–100, mindestens ein Testfall je Bereich. Nichts wird ergänzt oder
 * umgedeutet – eine ungültige Meldung wird als Ganzes abgelehnt.
 */
export function validateCoverage(data: unknown): CoverageValidation {
  if (typeof data !== 'object' || data === null) return { ok: false, errors: ['Meldung ist kein Objekt.'] };
  const { summary, areas } = data as { summary?: unknown; areas?: unknown };
  if (!Array.isArray(areas) || !areas.length) return { ok: false, errors: ['Keine Bereiche gemeldet.'] };
  const errors: string[] = [];
  const valid: CoverageArea[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of areas.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      errors.push(`Eintrag ${index + 1}: kein Objekt.`);
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const name = typeof entry.area === 'string' ? entry.area.trim().toLowerCase() : '';
    const label = typeof entry.area === 'string' ? `„${entry.area.slice(0, 60)}“` : `Eintrag ${index + 1}`;
    if (!isCoverageAreaKey(name)) {
      errors.push(`Bereich ${label} unbekannt (erlaubt: ${KEYS}).`);
      continue;
    }
    const area = name;
    if (seen.has(area)) {
      errors.push(`Bereich ${area} doppelt gemeldet.`);
      continue;
    }
    seen.add(area);
    const problems: string[] = [];
    if (!isPercent(entry.lines)) problems.push('Zeilenwert (lines) fehlt oder liegt nicht zwischen 0 und 100');
    if (!isPercent(entry.branches)) problems.push('Zweigwert (branches) fehlt oder liegt nicht zwischen 0 und 100');
    for (const key of ['statements', 'functions'] as const) {
      if (entry[key] !== undefined && entry[key] !== null && !isPercent(entry[key])) {
        problems.push(`${key} liegt nicht zwischen 0 und 100`);
      }
    }
    const counts = {} as Record<'unit' | 'component' | 'integration' | 'e2e' | 'passed' | 'failed', number>;
    for (const key of ['unit', 'component', 'integration', 'e2e', 'passed', 'failed'] as const) {
      const value = entry[key];
      if (value === undefined) counts[key] = 0;
      else if (isCount(value)) counts[key] = value;
      else problems.push(`${key} ist keine ganze Zahl ≥ 0`);
    }
    if (!problems.length && counts.unit + counts.component + counts.integration + counts.e2e === 0) {
      problems.push('0 Testfälle');
    }
    if (problems.length) {
      errors.push(`Bereich ${area}: ${problems.join(', ')}.`);
      continue;
    }
    valid.push({
      area,
      ...counts,
      lines: entry.lines as number,
      statements: isPercent(entry.statements) ? entry.statements : null,
      branches: entry.branches as number,
      functions: isPercent(entry.functions) ? entry.functions : null,
    });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, report: { summary: typeof summary === 'string' ? summary.slice(0, 8000) : '', areas: valid } };
}

/** Wird von saveCoverage geworfen, wenn ein Bericht den Validator nicht besteht (HTTP: 400). */
export class CoverageValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(`Testabdeckung abgelehnt: ${errors.join(' ')}`);
  }
}

/**
 * Liest den @@COVERAGE-Block des Testers. report = null und errors leer: kein Block. report = null mit errors: Block
 * ungültig und verworfen (Grund für den Schrittverlauf).
 */
export function parseCoverage(output: string): { report: CoverageReport | null; errors: string[] } {
  // Bei mehreren Blöcken zählt der letzte (Messung nach dem Schreiben neuer Tests).
  const json = [...output.matchAll(MARKER)].at(-1)?.[1];
  if (!json) return { report: null, errors: [] };
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { report: null, errors: ['Kein gültiges JSON.'] };
  }
  const result = validateCoverage(data);
  return result.ok ? { report: result.report, errors: [] } : { report: null, errors: result.errors };
}

/** Entfernt den Block aus der angezeigten Ausgabe. */
export function stripCoverage(output: string): string {
  return output.replace(MARKER, '').trimEnd();
}

/** Prüft den Bericht mit dem gemeinsamen Validator und speichert ihn in einer Transaktion; ungültig → nichts gespeichert. */
export async function saveCoverage(
  pool: Pool,
  project: string,
  developmentId: string | null,
  report: CoverageReport,
): Promise<string> {
  const checked = validateCoverage(report);
  if (!checked.ok) throw new CoverageValidationError(checked.errors);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = (
      await client.query<{ id: string }>(
        `INSERT INTO test_coverage_reports (project_slug, development_id, summary) VALUES ($1, $2, $3) RETURNING id`,
        [project, developmentId, checked.report.summary],
      )
    ).rows[0]?.id;
    for (const area of checked.report.areas) {
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
    return id ?? '';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
