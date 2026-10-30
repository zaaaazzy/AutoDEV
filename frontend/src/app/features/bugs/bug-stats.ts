import type { Bug } from '../../core/models.js';
import { NAVIGATION } from '../../core/navigation.js';
import { categoryLabel } from '../../shared/labels.js';
import { defined } from '../../../../../src/core/defined.js';

/** Begraben: behoben, nicht behoben (kein Fix) oder abgelehnt – liegt auf dem Bug-Friedhof. */
export function isBuried(bug: Pick<Bug, 'status'>): boolean {
  return bug.status === 'fixed' || bug.status === 'wontfix' || bug.status === 'rejected';
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
  };
}
