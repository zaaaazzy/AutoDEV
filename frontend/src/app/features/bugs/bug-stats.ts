import type { Bug, Sprint } from '../../core/models.js';
import { BUG_STATUS } from '../../core/models.js';
import { NAVIGATION } from '../../core/navigation.js';
import { BUG_CATEGORIES, bugCategoryLabel, categoryLabel } from '../../shared/labels.js';
import type { BugCategoryValue } from '../../../../../src/core/bug-category-values.js';
import { defined } from '../../../../../src/core/defined.js';

/** Begraben: behoben, nicht behoben (kein Fix) oder abgelehnt – liegt auf dem Bug-Friedhof. */
export function isBuried(bug: Pick<Bug, 'status'>): boolean {
  return bug.status === BUG_STATUS.fixed || bug.status === BUG_STATUS.wontfix || bug.status === BUG_STATUS.rejected;
}

export interface BugStatRow {
  label: string;
  open: number;
  buried: number;
  total: number;
}

export interface BugStats {
  open: number;
  buried: number;
  /** Wer ihn gefunden hat: Oberflächentest, Tester, Entwickler, von Hand … */
  finders: BugStatRow[];
  /** Wo: Seite der Anwendung (aus den Befunden) bzw. Bereich (Kategorie). */
  places: BugStatRow[];
  /** In welchen Tests: Testname (mit Gerät) und genannte Testdateien. */
  tests: BugStatRow[];
  /**
   * Verteilung nach der bestätigten Bug-Kategorie (`bugCategory`, security, git-sync, …); ohne oder nur vorgeschlagen
   * als „Ohne Kategorie“. Der Bereich (Frontend, Backend, …) steckt in „Wo“.
   */
  categories: BugStatRow[];
}

/** Zahl je Kategorie und Sprint wie in `GET /projects/:slug/stats` (bugsByCategorySprint). */
export interface BugCategorySprintPair {
  category: BugCategoryValue | null;
  sprintId: string | null;
  sprintName: string | null;
  open: number;
  buried: number;
}

export interface BugCategoryMatrixCell {
  open: number;
  buried: number;
}

/** Tabelle Kategorie × Sprint: Zeilen die acht Kategorien und „Ohne Kategorie“, Spalten Sprints und „Kein Sprint“. */
export interface BugCategoryMatrix {
  sprints: { id: string | null; name: string }[];
  rows: { category: BugCategoryValue | null; label: string; cells: BugCategoryMatrixCell[]; total: number }[];
  /** Summe je Spalte (Sprint). */
  totals: BugCategoryMatrixCell[];
  /** Summe aller Zellen = Zahl aller Bugs. */
  total: number;
}

const PAGE_LABELS = new Map(NAVIGATION.map((item) => [item.id as string, item.label]));
const KNOWN_FINDERS = /^(Tester|Entwickler|Reviewer|Dokumentierer|Auftragsautor|Oberflächentest|Problemanalyse)\s*:/;
const TEST_FILE = /([\w.-]+\.(?:spec|test|check)\.(?:ts|mjs|js))\b/g;
const NOT_OK = /^not ok \d+ - (.+)$/gm;
const UI_TEST = /Oberflächentest \*\*(.+?)\*\*(?: auf (\w+))?/;
const FINDING_PAGE = /^\s*[-*] ([a-z-]+) · /gm;
/** Bereich aus genannten Dateipfaden, z. B. `frontend/src/…` oder `backend/src/…`. */
const PATH_AREA = /(?:^|[\s`([])((?:frontend|backend|src|e2e|scripts|contracts|deploy|docs)\/)[\w./-]+/g;
const AREA_LABELS: Record<string, string> = {
  'frontend/': 'Frontend',
  'backend/': 'Backend',
  'src/': 'Backend',
  'e2e/': 'E2E-Tests',
  'scripts/': 'Skripte',
  'contracts/': 'Contracts',
  'deploy/': 'Betrieb',
  'docs/': 'Dokumentation',
};

function finder(bug: Bug): string {
  if (bug.source === 'test') return 'Oberflächentest';
  const match = KNOWN_FINDERS.exec(bug.title);
  if (match) return defined(match[1]);
  return bug.source === 'manual' ? 'Von Hand gemeldet' : 'Agent';
}

function places(bug: Bug): string[] {
  const found = new Set<string>();
  for (const match of bug.description.matchAll(FINDING_PAGE)) {
    const page = PAGE_LABELS.get(defined(match[1]));
    if (page) found.add(`Seite ${page}`);
  }
  if (bug.category) found.add(categoryLabel(bug.category));
  if (!found.size) {
    for (const match of bug.description.matchAll(PATH_AREA)) found.add(defined(AREA_LABELS[defined(match[1])]));
  }
  return found.size ? [...found] : ['Ohne Zuordnung'];
}

function tests(bug: Bug): string[] {
  const found = new Set<string>();
  const ui = UI_TEST.exec(bug.description);
  if (ui) found.add(ui[2] ? `${ui[1]} (${ui[2]})` : defined(ui[1]));
  for (const match of bug.description.matchAll(NOT_OK)) found.add(defined(match[1]).trim().slice(0, 80));
  for (const match of bug.description.matchAll(TEST_FILE)) found.add(defined(match[1]));
  return [...found];
}

function tally(bugs: Bug[], keys: (bug: Bug) => string[]): BugStatRow[] {
  const rows = new Map<string, BugStatRow>();
  for (const bug of bugs) {
    for (const label of keys(bug)) {
      const row = rows.get(label) ?? { label, open: 0, buried: 0, total: 0 };
      if (isBuried(bug)) row.buried += 1;
      else row.open += 1;
      row.total += 1;
      rows.set(label, row);
    }
  }
  return [...rows.values()].sort((a, b) => b.total - a.total || b.open - a.open || a.label.localeCompare(b.label));
}

export function bugStats(bugs: Bug[]): BugStats {
  const buried = bugs.filter(isBuried).length;
  return {
    open: bugs.length - buried,
    buried,
    finders: tally(bugs, (bug) => [finder(bug)]),
    places: tally(bugs, places),
    tests: tally(bugs, tests),
    categories: tally(bugs, (bug) => [bugCategoryLabel(bug.bugCategory)]),
  };
}

/** Paare Kategorie × Sprint aus der Bug-Liste, gezählt wie in der API (nur bestätigte Kategorie). */
export function bugCategoryPairs(bugs: Bug[], sprints: Pick<Sprint, 'id' | 'name'>[]): BugCategorySprintPair[] {
  const names = new Map(sprints.map((sprint) => [sprint.id, sprint.name]));
  const pairs = new Map<string, BugCategorySprintPair>();
  for (const bug of bugs) {
    const category = bug.bugCategory ?? null;
    const sprintId = bug.sprintId ?? null;
    const key = `${category ?? ''}|${sprintId ?? ''}`;
    const pair = pairs.get(key) ?? {
      category,
      sprintId,
      sprintName: sprintId ? (names.get(sprintId) ?? null) : null,
      open: 0,
      buried: 0,
    };
    if (isBuried(bug)) pair.buried += 1;
    else pair.open += 1;
    pairs.set(key, pair);
  }
  // Sprints in der Reihenfolge der Sprint-Liste, „Kein Sprint“ zuletzt.
  const order = new Map(sprints.map((sprint, index) => [sprint.id, index]));
  const rank = (pair: BugCategorySprintPair): number =>
    pair.sprintId === null ? sprints.length + 1 : (order.get(pair.sprintId) ?? sprints.length);
  return [...pairs.values()].sort((a, b) => rank(a) - rank(b));
}

/**
 * Tabelle Kategorie × Sprint aus den Paaren: Sprints in der Reihenfolge der Paare (die API liefert sie nach Anlage),
 * „Kein Sprint“ zuletzt. Alle acht Kategorien erscheinen, „Ohne Kategorie“ nur, wenn es solche Bugs gibt.
 */
export function bugCategoryMatrix(pairs: BugCategorySprintPair[]): BugCategoryMatrix {
  const sprintIds = [...new Set(pairs.map((pair) => pair.sprintId))].sort(
    (a, b) => Number(a === null) - Number(b === null),
  );
  const sprints = sprintIds.map((id) => ({
    id,
    name:
      id === null ? 'Kein Sprint' : (pairs.find((pair) => pair.sprintId === id)?.sprintName ?? 'Unbekannter Sprint'),
  }));
  const categories: (BugCategoryValue | null)[] = [...BUG_CATEGORIES];
  if (pairs.some((pair) => pair.category === null)) categories.push(null);
  const cell = (category: BugCategoryValue | null, sprintId: string | null): BugCategoryMatrixCell => {
    const matching = pairs.filter((pair) => pair.category === category && pair.sprintId === sprintId);
    return {
      open: matching.reduce((sum, pair) => sum + pair.open, 0),
      buried: matching.reduce((sum, pair) => sum + pair.buried, 0),
    };
  };
  const rows = categories.map((category) => {
    const cells = sprintIds.map((sprintId) => cell(category, sprintId));
    return {
      category,
      label: bugCategoryLabel(category),
      cells,
      total: cells.reduce((sum, entry) => sum + entry.open + entry.buried, 0),
    };
  });
  const totals = sprintIds.map((sprintId) => {
    const column = categories.map((category) => cell(category, sprintId));
    return {
      open: column.reduce((sum, entry) => sum + entry.open, 0),
      buried: column.reduce((sum, entry) => sum + entry.buried, 0),
    };
  });
  return { sprints, rows, totals, total: rows.reduce((sum, row) => sum + row.total, 0) };
}
