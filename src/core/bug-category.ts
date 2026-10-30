/**
 * Regelbasierte Bug-Kategorie (ohne KI): aus Titel, Beschreibung und optional der Quelle (z. B. Dienst bei
 * Betriebsfehlern). Die Regeln stehen in einer Tabelle je Kategorie und werden in fester Reihenfolge geprüft:
 * Sicherheit, Git-Sync, CI, Runner, Dokumentation, dann die Bereiche. Treffen mehrere Bereiche zu, gilt Fullstack.
 * Ohne Treffer bleibt die Kategorie leer (nicht raten). Dieselbe Tabelle erzeugt das SQL der Nachkategorisierung
 * (Migration 19), damit es nur eine Regel gibt.
 */
export const BUG_CATEGORY_VALUES = [
  'security',
  'git-sync',
  'ci',
  'runner',
  'docs',
  'frontend',
  'backend',
  'fullstack',
  'infrastructure',
] as const;
export type BugCategory = (typeof BUG_CATEGORY_VALUES)[number];

export interface BugCategoryRule {
  category: BugCategory;
  /** Pfadanfänge (z. B. `src/runner/git-sync/`), auch mitten in einem längeren Pfad, aber nicht mitten in einem Wort. */
  paths: readonly string[];
  /** Stichworte als ganze Wörter, ohne Gross-/Kleinschreibung. Beginnt eines mit `.`, passt es als Dateiendung. */
  keywords: readonly string[];
}

/** Vorrangige Kategorien in Prüfreihenfolge: die erste, die trifft, gilt. */
export const PRIORITY_RULES: readonly BugCategoryRule[] = [
  {
    category: 'security',
    paths: [
      'src/core/secret',
      'src/core/egress-proxy',
      'src/core/bug-trust',
      'src/api/auth',
      'src/api/access',
      'agent-guard',
    ],
    keywords: [
      'security',
      'sicherheit',
      'sicherheitslücke',
      'sicherheitsproblem',
      'schwachstelle',
      'vulnerability',
      'cve',
      'ssrf',
      'rce',
      'xss',
      'csrf',
      'redos',
      'injection',
      'sql-injection',
      'prompt-injection',
      'path traversal',
      'directory traversal',
      'privilege escalation',
      'rechteausweitung',
      'rechteprüfung',
      'secret',
      'secrets',
    ],
  },
  {
    category: 'git-sync',
    paths: ['src/runner/git-sync', 'src/runner/github-sync', 'src/runner/git-helpers'],
    keywords: [
      'git-sync',
      'git sync',
      'worktree',
      'worktrees',
      'wip-commit',
      'wip commit',
      'merge-konflikt',
      'mergekonflikt',
      'merge conflict',
      'rebase',
      'sprint-branch',
      'sprint-tag',
      'git push',
      'git pull',
      'git merge',
      'force-push',
      'detached head',
    ],
  },
  {
    category: 'ci',
    paths: ['.github/workflows'],
    keywords: ['ci', 'github actions', 'github-actions', 'gh run'],
  },
  {
    category: 'runner',
    paths: ['src/runner/'],
    keywords: ['runner', 'worker', 'lebenszeichen', 'heartbeat', 'agent-prozess'],
  },
  {
    category: 'docs',
    paths: ['docs/benutzerhandbuch', 'docs/handbuch', 'readme.md'],
    keywords: ['dokumentation', 'doku', 'handbuch', 'benutzerhandbuch', 'readme'],
  },
];

/** Bereiche für den Rückfall: einer trifft = dieser Bereich, mehrere = Fullstack. */
export const AREA_RULES: readonly BugCategoryRule[] = [
  {
    category: 'frontend',
    paths: ['frontend/'],
    keywords: [
      'frontend',
      'oberfläche',
      'oberflächentest',
      'ui',
      'desktop',
      'handy',
      'browser',
      'angular',
      'layout',
      'css',
      '.html',
      '.scss',
    ],
  },
  {
    category: 'backend',
    paths: ['src/api/', 'src/core/', 'src/db/', 'src/agent/'],
    keywords: ['backend', 'api', 'express', 'endpoint', 'sql'],
  },
  {
    category: 'infrastructure',
    paths: ['docker-compose', 'dockerfile', 'deploy/'],
    keywords: ['infrastruktur', 'infrastructure', 'docker', 'postgres', 'postgresql', 'redis', 'deploy', 'container'],
  },
];

/** Buchstaben, Ziffern, Unterstrich: Wortzeichen (nach lower()) – in JavaScript und PostgreSQL gleich ausgewertet. */
const WORD = '[a-z0-9_äöüß]';
const escape = (text: string): string => text.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isWordChar = (char: string): boolean => new RegExp(WORD).test(char);

function keywordPattern(keyword: string): string {
  const lower = keyword.toLowerCase();
  const before = isWordChar(lower[0] ?? '') ? `(?<!${WORD})` : '';
  const after = isWordChar(lower.at(-1) ?? '') ? `(?!${WORD})` : '';
  return `${before}${escape(lower)}${after}`;
}

const pathPattern = (path: string): string => `(?<![a-z0-9_äöüß.-])${escape(path)}`;

/** Ein regulärer Ausdruck je Regel (für kleingeschriebenen Text), gültig in JavaScript und PostgreSQL. */
export function rulePattern(rule: BugCategoryRule): string {
  return [...rule.paths.map(pathPattern), ...rule.keywords.map(keywordPattern)].join('|');
}

const compiled = new Map<BugCategoryRule, RegExp>();
function matches(rule: BugCategoryRule, text: string): boolean {
  let pattern = compiled.get(rule);
  if (!pattern) compiled.set(rule, (pattern = new RegExp(rulePattern(rule))));
  return pattern.test(text);
}

export interface BugCategoryInput {
  title: string;
  description?: string | null;
  /** Herkunft, z. B. der Dienst eines Betriebsfehlers. */
  source?: string | null;
}

const textOf = (bug: BugCategoryInput): string =>
  [bug.title, bug.description ?? '', bug.source ?? ''].join('\n').toLowerCase();

/** Nur die vorrangigen Kategorien (Sicherheit bis Dokumentation), ohne Bereichs-Rückfall. */
export function priorityCategory(bug: BugCategoryInput): BugCategory | null {
  const text = textOf(bug);
  return PRIORITY_RULES.find((rule) => matches(rule, text))?.category ?? null;
}

export function categorizeBug(bug: BugCategoryInput): BugCategory | null {
  const special = priorityCategory(bug);
  if (special) return special;
  const text = textOf(bug);
  const areas = AREA_RULES.filter((rule) => matches(rule, text));
  if (areas.length > 1) return 'fullstack';
  return areas[0]?.category ?? null;
}

const literal = (text: string): string => `'${text.replace(/'/g, "''")}'`;

/**
 * Dieselbe Regel als SQL-Ausdruck über einen bereits kleingeschriebenen Text (z. B. `lower(title || description)`);
 * liefert die Kategorie oder NULL.
 */
export function bugCategorySql(text: string): string {
  const special = PRIORITY_RULES.map((rule) => `WHEN ${text} ~ ${literal(rulePattern(rule))} THEN '${rule.category}'`);
  const hits = AREA_RULES.map((rule) => `(${text} ~ ${literal(rulePattern(rule))})::int`).join(' + ');
  const areas = AREA_RULES.map((rule) => `WHEN ${text} ~ ${literal(rulePattern(rule))} THEN '${rule.category}'`);
  return `CASE ${special.join(' ')} WHEN ${hits} > 1 THEN 'fullstack' ${areas.join(' ')} END`;
}
