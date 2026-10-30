/**
 * Feste Bereiche der Testabdeckung. Gespeichert wird nur unter diesen Schlüsseln; die Migration 19 setzt dieselbe
 * Liste als CHECK auf test_coverage_areas.area (ein Test prüft, dass beide übereinstimmen).
 */
export const COVERAGE_AREA_KEYS = ['backend', 'frontend', 'contracts', 'scripts', 'e2e', 'gesamt'] as const;

export type CoverageAreaKey = (typeof COVERAGE_AREA_KEYS)[number];

/** Bezeichnungen für die Oberfläche. */
export const COVERAGE_AREA_LABELS: Record<CoverageAreaKey, string> = {
  backend: 'Backend',
  frontend: 'Frontend',
  contracts: 'Contracts',
  scripts: 'Skripte',
  e2e: 'E2E',
  gesamt: 'Gesamt',
};

export function isCoverageAreaKey(value: unknown): value is CoverageAreaKey {
  return typeof value === 'string' && (COVERAGE_AREA_KEYS as readonly string[]).includes(value);
}

/** Nur ganze Namensteile (getrennt durch Leerzeichen, -, _, /, Klammern usw.): „builder“ ist kein „ui“. */
const word = (words: string) => new RegExp(`(?:^|[^a-z0-9äöüß])(?:${words})s?(?=$|[^a-z0-9äöüß])`, 'i');

const GESAMT = word('gesamt|zusammen|insgesamt');
const BACKEND = word('backend|server|api');
const FRONTEND = word('frontend|web|ui|client');

/**
 * Reihenfolge wie in der Migration 19: zuerst „gesamt“, dann die Einzelbereiche. Wer Backend und Frontend zusammen
 * meldet, meldet ebenfalls „gesamt“.
 */
const RULES: readonly [CoverageAreaKey, (label: string) => boolean][] = [
  ['gesamt', (label) => GESAMT.test(label) || (BACKEND.test(label) && FRONTEND.test(label))],
  ['backend', (label) => BACKEND.test(label)],
  ['frontend', (label) => FRONTEND.test(label)],
  ['contracts', (label) => word('contract|shared|common').test(label)],
  ['scripts', (label) => word('script|skripte?').test(label)],
  ['e2e', (label) => word('e2e|end-to-end|playwright').test(label)],
];

/** Ordnet eine gemeldete Bezeichnung („Backend (Express)“) einem festen Schlüssel zu; null, wenn keiner passt. */
export function coverageAreaKey(label: string): CoverageAreaKey | null {
  const text = label.trim();
  return RULES.find(([, matches]) => matches(text))?.[0] ?? null;
}

export interface CoverageValues {
  lines: number | null;
  branches: number | null;
  functions: number | null;
}

/** Dieselbe Regel in SQL für test_coverage_areas mit dem Alias `a`. */
export const COMPLETE_COVERAGE_SQL = 'a.lines IS NOT NULL AND a.branches IS NOT NULL AND a.functions IS NOT NULL';

/** Vollständiger Lauf: Zeilen-, Verzweigungs- und Funktionsabdeckung sind alle gesetzt. */
export function isCompleteCoverage(area: CoverageValues): boolean {
  return area.lines !== null && area.branches !== null && area.functions !== null;
}
