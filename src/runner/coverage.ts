import type { Pool } from 'pg';
import { COVERAGE_AREA_KEYS, coverageAreaKey, isCompleteCoverage } from '../core/coverage-areas.js';

/** Ab dieser Zeilenabdeckung gilt ein Bereich als ausreichend getestet. */
export const COVERAGE_TARGET = 75;

const MARKER = /^@@COVERAGE\s+(\{.*\})\s*$/gm;

const KEYS = COVERAGE_AREA_KEYS.join(', ');

/** Anweisung an den Tester: Abdeckung messen, Lücken mit Tests schließen, Ergebnis maschinenlesbar melden. */
export const COVERAGE_INSTRUCTIONS = `## Testabdeckung (wenn möglich; AIdeation misst nach deinem Schritt selbst)
1. Ermittle, soweit deine Rechte das erlauben, pro Bereich des Projekts die Testabdeckung. Als Bereich gilt nur einer dieser Schlüssel: ${KEYS} („gesamt“ nur, wenn du einen Wert über das ganze Projekt gemessen hast). Andere Bezeichnungen werden nicht gespeichert. Gibt es ein npm-Skript \`test:coverage\`, nutze zuerst \`npm run test:coverage\`; sonst die Werkzeuge des Projekts (z. B. \`ng test --watch=false --coverage\`, \`tsx --test --experimental-test-coverage\`, \`vitest --coverage\`). Fehlt ein Coverage-Werkzeug, richte es als devDependency ein.
2. Zähle die Testfälle je Bereich nach Testart: Unit-Tests (isolierte Funktionen/Services), Komponententests (UI-Komponenten mit TestBed o. Ä.), Integrationstests (mehrere Schichten, z. B. HTTP-Route mit Datenbank) und End-to-End-Tests (E2E, Browser über die ganze Anwendung).
3. Liegt die Zeilenabdeckung eines Bereichs unter ${COVERAGE_TARGET} % oder ist der geänderte Code des Auftrags ungetestet, schreibe gezielt Tests für die ungetesteten, fachlich wichtigen Pfade und miss danach erneut.
4. Lässt sich die Abdeckung nicht messen (Werkzeug fehlt, Befehl vom Wächter gesperrt), melde die Prozentwerte als null und arbeite weiter – das ist kein Fehler und kein Grund, die Abnahme abzulehnen. AIdeation misst die Abdeckung nach deinem Schritt selbst; ein Bereich ohne Zeilen-, Verzweigungs- und Funktionsabdeckung wird nicht gespeichert.
5. Beende deine Antwort mit genau einer Zeile in diesem Format (gültiges JSON in einer Zeile, Prozentwerte als Zahl, unbekannt = null):
@@COVERAGE {"summary":"<kurze Zusammenfassung in Markdown, inkl. neu geschriebener Tests und verbleibender Lücken>","areas":[{"area":"frontend","unit":0,"component":0,"integration":0,"e2e":0,"passed":0,"failed":0,"lines":0,"statements":0,"branches":0,"functions":0}]}`;

export interface CoverageArea {
  /** Schlüssel aus COVERAGE_AREA_KEYS; bei einer Messung ohne erkennbaren Bereich der Name des Pakets. */
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
  /** Verworfene Einträge mit Grund (für den Schritt-Log). */
  discarded?: string[];
}

/** Grund, warum eine Bezeichnung keinem Bereich zugeordnet werden kann. */
export function unknownAreaReason(label: string): string {
  return `„${label}“ verworfen: keinem Bereich zuordenbar (erlaubt: ${KEYS})`;
}

const count = (value: unknown): number => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0);
const percent = (value: unknown): number | null =>
  value === null || value === undefined || value === '' || !Number.isFinite(Number(value))
    ? null
    : Math.min(100, Math.max(0, Number(value)));

/**
 * Liest den @@COVERAGE-Block des Testers; null, wenn keiner oder kein gültiger vorhanden ist. Bezeichnungen werden
 * auf die festen Schlüssel abgebildet, nicht zuordenbare landen mit Grund in `discarded`. Einträge ohne Prozentwerte
 * bleiben hier noch stehen: Die Messung von AIdeation kann sie ergänzen (mergeCoverage), verworfen wird beim Speichern.
 */
export function parseCoverage(output: string): CoverageReport | null {
  // Bei mehreren Blöcken zählt der letzte (Messung nach dem Schreiben neuer Tests).
  const json = [...output.matchAll(MARKER)].at(-1)?.[1];
  if (!json) return null;
  try {
    const data = JSON.parse(json) as { summary?: unknown; areas?: unknown };
    if (!Array.isArray(data.areas)) return null;
    const discarded: string[] = [];
    const entries = data.areas
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .filter((entry) => typeof entry.area === 'string' && entry.area.trim());
    const areas = entries
      .flatMap((entry) => {
        const label = String(entry.area).trim().slice(0, 60);
        const key = coverageAreaKey(label);
        if (!key) discarded.push(unknownAreaReason(label));
        return key ? [{ key, entry }] : [];
      })
      .map(({ key, entry }) => ({
        area: key,
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
    if (!entries.length) return null;
    return { summary: typeof data.summary === 'string' ? data.summary.slice(0, 8000) : '', areas, discarded };
  } catch {
    return null;
  }
}

/** Entfernt den Block aus der angezeigten Ausgabe. */
export function stripCoverage(output: string): string {
  return output.replace(MARKER, '').trimEnd();
}

const MISSING: [keyof CoverageArea, string][] = [
  ['lines', 'Zeilen'],
  ['branches', 'Verzweigungen'],
  ['functions', 'Funktionen'],
];

/**
 * Was gespeichert wird: nur feste Schlüssel, nur vollständige Läufe (Zeilen, Verzweigungen, Funktionen gesetzt), je
 * Schlüssel einmal (der erste gilt). Alles andere steht mit Grund in `discarded`.
 */
export function selectCoverage(report: CoverageReport): { areas: CoverageArea[]; discarded: string[] } {
  const discarded = [...(report.discarded ?? [])];
  const seen = new Set<string>();
  const areas = report.areas.flatMap((area) => {
    const key = coverageAreaKey(area.area);
    if (!key) {
      discarded.push(unknownAreaReason(area.area));
      return [];
    }
    if (!isCompleteCoverage(area)) {
      const missing = MISSING.filter(([field]) => area[field] === null).map(([, label]) => label);
      discarded.push(`${key} verworfen: ohne Prozentwerte (fehlt: ${missing.join(', ')})`);
      return [];
    }
    if (seen.has(key)) {
      discarded.push(`${key} verworfen: doppelt gemeldet`);
      return [];
    }
    seen.add(key);
    return [{ ...area, area: key }];
  });
  return { areas, discarded };
}

/**
 * Speichert den Bericht in einer Transaktion (siehe selectCoverage). Bleibt kein Bereich übrig, wird kein Bericht
 * angelegt. Gibt die gespeicherten Schlüssel und die Gründe für verworfene Einträge zurück.
 */
export async function saveCoverage(
  pool: Pool,
  project: string,
  developmentId: string | null,
  report: CoverageReport,
): Promise<{ saved: string[]; discarded: string[] }> {
  const { areas, discarded } = selectCoverage(report);
  if (!areas.length) return { saved: [], discarded };
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
    return { saved: areas.map((area) => area.area), discarded };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
