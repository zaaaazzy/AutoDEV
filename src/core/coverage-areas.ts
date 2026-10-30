/**
 * Die feste Liste der Abdeckungsbereiche – die einzige Stelle im Code. Speicherung, Messung, Tester-Prompt und Anzeige
 * verwenden nur diese Schlüssel; ein neuer Bereich braucht eine Codeänderung (gewollt). „auftrag“ = Abdeckung des vom
 * Auftrag geänderten Codes, „gesamt“ = das ganze Projekt. Die Migration 24 setzt dieselbe Liste als CHECK auf
 * test_coverage_areas.area (ein Test prüft, dass beide übereinstimmen).
 */
export const COVERAGE_AREA_KEYS = ['backend', 'frontend', 'contracts', 'scripts', 'e2e', 'gesamt', 'auftrag'] as const;

export type CoverageAreaKey = (typeof COVERAGE_AREA_KEYS)[number];

/** Bezeichnungen für die Oberfläche. */
export const COVERAGE_AREA_LABELS: Record<CoverageAreaKey, string> = {
  backend: 'Backend',
  frontend: 'Frontend',
  contracts: 'Contracts',
  scripts: 'Skripte',
  e2e: 'E2E',
  gesamt: 'Gesamt',
  auftrag: 'Auftrag',
};

export function isCoverageAreaKey(value: unknown): value is CoverageAreaKey {
  return typeof value === 'string' && (COVERAGE_AREA_KEYS as readonly string[]).includes(value);
}

/**
 * Bekannte Schreibweisen (klein geschrieben, ohne Leerraum am Rand) → fester Bereich. Dieselbe Zuordnung füllt
 * Migration 24 (coverage_area_aliases) und benennt die Messung durch AIdeation (areaName). Neue Schreibweisen nur
 * hier und per neuer Migration ergänzen, Migration 24 nicht ändern.
 */
export const COVERAGE_AREA_ALIASES: Readonly<Record<string, CoverageAreaKey>> = {
  backend: 'backend',
  'back-end': 'backend',
  'backend (src)': 'backend',
  'backend/api': 'backend',
  server: 'backend',
  api: 'backend',
  frontend: 'frontend',
  'front-end': 'frontend',
  'frontend (angular)': 'frontend',
  angular: 'frontend',
  web: 'frontend',
  ui: 'frontend',
  client: 'frontend',
  oberfläche: 'frontend',
  contracts: 'contracts',
  contract: 'contracts',
  'contracts/shared': 'contracts',
  shared: 'contracts',
  common: 'contracts',
  scripts: 'scripts',
  script: 'scripts',
  skripte: 'scripts',
  skript: 'scripts',
  tools: 'scripts',
  e2e: 'e2e',
  'e2e-tests': 'e2e',
  'end-to-end': 'e2e',
  playwright: 'e2e',
  gesamt: 'gesamt',
  total: 'gesamt',
  'all files': 'gesamt',
  alle: 'gesamt',
  projekt: 'gesamt',
  project: 'gesamt',
  'dev-log': 'gesamt',
  devlog: 'gesamt',
  aideation: 'gesamt',
  auftrag: 'auftrag',
  order: 'auftrag',
  'geänderter code': 'auftrag',
  'changed code': 'auftrag',
};

/** Fester Bereich zu einer bekannten Schreibweise (exakt), sonst null (kein stilles Anlegen neuer Bereiche). */
export function canonicalArea(name: string): CoverageAreaKey | null {
  return COVERAGE_AREA_ALIASES[name.trim().toLowerCase()] ?? null;
}

/** Nur ganze Namensteile (getrennt durch Leerzeichen, -, _, /, Klammern usw.): „builder“ ist kein „ui“. */
const word = (words: string) => new RegExp(`(?:^|[^a-z0-9äöüß])(?:${words})s?(?=$|[^a-z0-9äöüß])`, 'i');

const GESAMT = word('gesamt|zusammen|insgesamt');
const BACKEND = word('backend|server|api');
const FRONTEND = word('frontend|web|ui|client');

/**
 * Reihenfolge wie in der Migration 23: zuerst „gesamt“, dann die Einzelbereiche. Wer Backend und Frontend zusammen
 * meldet, meldet ebenfalls „gesamt“. „auftrag“ kam mit Migration 24 dazu und steht deshalb zuletzt.
 */
const RULES: readonly [CoverageAreaKey, (label: string) => boolean][] = [
  ['gesamt', (label) => GESAMT.test(label) || (BACKEND.test(label) && FRONTEND.test(label))],
  ['backend', (label) => BACKEND.test(label)],
  ['frontend', (label) => FRONTEND.test(label)],
  ['contracts', (label) => word('contract|shared|common').test(label)],
  ['scripts', (label) => word('script|skripte?').test(label)],
  ['e2e', (label) => word('e2e|end-to-end|playwright').test(label)],
  ['auftrag', (label) => word('auftrag').test(label)],
];

/** Ordnet eine Bezeichnung („Backend (Express)“) per Ganzwort einem festen Schlüssel zu; null, wenn keiner passt. */
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
