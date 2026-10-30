import { logged } from '../core/log.js';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { sendPush } from '../core/push.js';
import { isShuttingDown } from '../core/shutdown.js';
import { CATEGORIES, shortTitle, TITLE_MAX } from '../core/validation.js';
import type { RunnerOptions } from '../runner/runner.js';
import { runAuthorAgent } from './requirements.js';
import { readProjectFile } from './tool-paths.js';
import { defined } from '../core/defined.js';

/**
 * Visionär: liest das Projekt (nur lesend), schlägt begründete Erweiterungsideen vor und legt sie in Ideation an.
 * Dubletten zu offenen oder abgelehnten Ideen werden verworfen; Ablehnungsgründe fliessen in den nächsten Lauf ein.
 */
export const VISIONARY_ROLE = 'visionary';
export const VISIONARY_AUTHOR = 'Visionär';
export const VISIONARY_LIMIT_KEY = 'visionary_max_ideas';
export const DEFAULT_VISIONARY_LIMIT = 5;
export const MAX_VISIONARY_LIMIT = 8;
/** Offene Läufe (angefragt oder laufend); je Projekt höchstens einer. */
export const OPEN_RUN_STATUSES = ['requested', 'running'] as const;

const IDEA_MARKER = '@@IDEA' as const;
/** Datenbezug der Begründung: „stützt sich auf …“ mit einer konkreten Angabe danach. */
const DATA_REFERENCE = /stützt sich auf\s+(.{12,})/i;
/** Floskeln ohne Bezug auf Daten des Projekts. */
const VAGUE_REFERENCE =
  /^(?:allgemeine?n?|übliche?n?|gängige?n?|bewährte?n?)\s+(?:erfahrung|praxis|best practices?|annahmen?)|^best practices?\b|^(?:meine|eigene)\s+(?:erfahrung|einschätzung)/i;
const PRIORITY_ALIASES: Record<string, string> = {
  low: 'low',
  niedrig: 'low',
  gering: 'low',
  medium: 'medium',
  mittel: 'medium',
  normal: 'medium',
  high: 'high',
  hoch: 'high',
};
const CATEGORY_ALIASES: Record<string, string> = {
  ui: 'frontend',
  ux: 'frontend',
  oberfläche: 'frontend',
  api: 'backend',
  server: 'backend',
  infra: 'infrastructure',
  infrastruktur: 'infrastructure',
  betrieb: 'infrastructure',
  devops: 'infrastructure',
  doku: 'docs',
  dokumentation: 'docs',
  documentation: 'docs',
  sicherheit: 'security',
  sec: 'security',
};

export interface VisionaryIdea {
  title: string;
  category: string | null;
  benefit: number | null;
  cost: number | null;
  priority: 'low' | 'medium' | 'high';
  reason: string;
  description: string;
}

export interface ParsedIdeas {
  ideas: VisionaryIdea[];
  /** Verworfene @@IDEA-Zeilen mit Grund (kaputtes JSON, fehlender Titel, kein Datenbezug). */
  discarded: { line: string; problem: string }[];
}

const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

function score(value: unknown): number | null {
  const number = typeof value === 'string' ? Number(value.trim()) : value;
  return typeof number === 'number' && Number.isFinite(number) ? Math.min(10, Math.max(0, Math.round(number))) : null;
}

function category(value: unknown): string | null {
  const key = text(value, 40).toLowerCase();
  if (CATEGORIES.has(key)) return key;
  return CATEGORY_ALIASES[key] ?? null;
}

/** Hat die Begründung einen konkreten Datenbezug („stützt sich auf <Bug, Bericht, Coverage …>“)? */
export function hasDataReference(reason: string): boolean {
  const match = DATA_REFERENCE.exec(reason);
  return Boolean(match && !VAGUE_REFERENCE.test(defined(match[1]).trim()));
}

/** Marker-Zeilen mit JSON am Ende einer Antwort: Ideen (Visionär, Routinen), Bugs und Aufträge (Routinen). */
export const RESULT_MARKERS = ['@@IDEA', '@@BUG', '@@ORDER'] as const;
export type ResultMarker = (typeof RESULT_MARKERS)[number];

export interface MarkerLine {
  marker: ResultMarker;
  line: string;
  record: Record<string, unknown>;
}

/** Beginn oder Ende eines Markdown-Codeblocks (``` oder ~~~, höchstens drei Leerzeichen eingerückt). */
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** Was vor einem Marker stehen darf: Einrückung und ein Listenpunkt („- “, „* “, „1. “). */
const LINE_START = /^[ \t]*(?:(?:[-*+]|\d{1,3}[.)])[ \t]+)?/;

/**
 * Liest Marker-Zeilen (`@@IDEA {…}`, `@@BUG {…}`, `@@ORDER {…}`) aus der Antwort; Fliesstext dazwischen wird
 * ignoriert. Ein Marker zählt nur am Zeilenanfang (davor höchstens Einrückung und Listenpunkt) und ausserhalb von Codeblöcken –
 * zitierter Dateiinhalt oder Fliesstext über Marker legt keine Einträge an. Zeilen mit kaputtem JSON landen mit Grund
 * unter `discarded`.
 */
export function parseMarkerLines(
  output: string,
  markers: readonly ResultMarker[] = RESULT_MARKERS,
): { lines: MarkerLine[]; discarded: { line: string; problem: string }[] } {
  const lines: MarkerLine[] = [];
  const discarded: { line: string; problem: string }[] = [];
  let fence: string | null = null;
  for (const raw of output.split(/\r?\n/)) {
    const fenceMatch = CODE_FENCE.exec(raw);
    if (fenceMatch) {
      // Ein Block endet nur mit demselben Zeichen, mindestens so lang wie beim Öffnen.
      const marks = defined(fenceMatch[1]);
      if (fence === null) fence = marks;
      else if (marks[0] === fence[0] && marks.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    // Vor dem Marker nur Einrückung und ein Listenpunkt; „@@IDEA“ trifft nicht „@@IDEAS“ o. ä.
    const rest = raw.slice(defined(LINE_START.exec(raw))[0].length);
    const marker = markers.find((candidate) => new RegExp(`^${candidate}(?![A-Z_])`).test(rest));
    if (!marker) continue;
    const line = rest.trim();
    const start = line.indexOf('{');
    const end = line.lastIndexOf('}');
    let data: unknown;
    try {
      data = start >= 0 && end > start ? JSON.parse(line.slice(start, end + 1)) : undefined;
    } catch {
      data = undefined;
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      discarded.push({ line, problem: 'Kein gültiges JSON.' });
      continue;
    }
    lines.push({ marker, line, record: data as Record<string, unknown> });
  }
  return { lines, discarded };
}

/** Titel aus einer Marker-Zeile (ohne Anführungszeichen, gekürzt). */
export function markerTitle(record: Record<string, unknown>): string {
  return shortTitle(text(record.title, 300).replace(/^["„“]+|["„“]+$/g, ''), TITLE_MAX);
}

/** Priorität aus einer Marker-Zeile (auch deutsch: niedrig, mittel, hoch); Standard mittel. */
export function markerPriority(value: unknown): 'low' | 'medium' | 'high' {
  return (PRIORITY_ALIASES[text(value, 20).toLowerCase()] ?? 'medium') as 'low' | 'medium' | 'high';
}

/** Kategorie, Nutzen und Kosten einer Marker-Zeile wie beim Visionär. */
export const markerCategory = category;
export const markerScore = score;

/** Liest die @@IDEA-Zeilen aus der Antwort; Fliesstext dazwischen wird ignoriert. */
export function parseIdeaLines(output: string): ParsedIdeas {
  const ideas: VisionaryIdea[] = [];
  const parsed = parseMarkerLines(output, [IDEA_MARKER]);
  const discarded: ParsedIdeas['discarded'] = [...parsed.discarded];
  for (const { line, record } of parsed.lines) {
    const title = markerTitle(record);
    const reason = text(record.reason, 1500);
    if (title.length < 3) {
      discarded.push({ line, problem: 'Titel fehlt.' });
      continue;
    }
    if (!hasDataReference(reason)) {
      discarded.push({ line, problem: 'Begründung ohne konkreten Datenbezug („stützt sich auf …“).' });
      continue;
    }
    ideas.push({
      title,
      category: category(record.category),
      benefit: score(record.benefit),
      cost: score(record.cost),
      priority: markerPriority(record.priority),
      reason,
      description: typeof record.description === 'string' ? record.description.trim().slice(0, 4000) : '',
    });
  }
  return { ideas, discarded };
}

const STOP_WORDS = new Set([
  'der',
  'die',
  'das',
  'den',
  'dem',
  'des',
  'ein',
  'eine',
  'einen',
  'einer',
  'und',
  'oder',
  'für',
  'fuer',
  'mit',
  'von',
  'im',
  'in',
  'am',
  'an',
  'auf',
  'zu',
  'zum',
  'zur',
  'bei',
  'the',
  'a',
  'an',
  'of',
  'for',
  'and',
  'to',
  'neue',
  'neuer',
  'neues',
]);

/** Kleinbuchstaben, Umlaute ausgeschrieben, nur Buchstaben/Ziffern, ohne Füllwörter. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replaceAll('ä', 'ae')
    .replaceAll('ö', 'oe')
    .replaceAll('ü', 'ue')
    .replaceAll('ß', 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word && !STOP_WORDS.has(word))
    .join(' ');
}

function trigrams(value: string): Set<string> {
  const result = new Set<string>();
  for (const word of value.split(' ')) {
    const padded = `  ${word} `;
    for (let index = 0; index + 3 <= padded.length; index += 1) result.add(padded.slice(index, index + 3));
  }
  return result;
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const entry of a) if (b.has(entry)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Ähnlichkeit zweier Titel (0–1): das Maximum aus Trigramm- und Wort-Jaccard der normalisierten Titel. */
export function titleSimilarity(a: string, b: string): number {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const words = jaccard(new Set(left.split(' ')), new Set(right.split(' ')));
  return Math.max(jaccard(trigrams(left), trigrams(right)), words);
}

export const SIMILARITY_THRESHOLD = 0.55;

export interface KnownIdea {
  id: string;
  title: string;
  status: string;
  rejectionReason?: string | null;
}

/** Ähnlichste bekannte Idee ab der Schwelle, sonst null. */
export function findDuplicate<T extends KnownIdea>(title: string, known: readonly T[]): T | null {
  let best: { idea: T; similarity: number } | null = null;
  for (const idea of known) {
    const similarity = titleSimilarity(title, idea.title);
    if (similarity >= SIMILARITY_THRESHOLD && (!best || similarity > best.similarity)) best = { idea, similarity };
  }
  return best?.idea ?? null;
}

export const clampLimit = (value: unknown): number => {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? Math.min(MAX_VISIONARY_LIMIT, number) : DEFAULT_VISIONARY_LIMIT;
};

export async function readVisionaryLimit(pool: Pool): Promise<number> {
  const row = (
    await pool
      .query<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', [VISIONARY_LIMIT_KEY])
      .catch(() => ({ rows: [] as { value: string }[] }))
  ).rows[0];
  return clampLimit(row?.value);
}

export interface VisionaryContext {
  docs: { path: string; text: string }[];
  fileTree: string[];
  sprintReports: { sprint: string; summary: string; problems: string[]; missing: string[] }[];
  bugsByCategory: Record<string, { title: string; status: string; severity: string }[]>;
  actionTodos: { title: string; todo: string }[];
  coverage: { area: string; lines: number | null; branches: number | null; tests: number }[];
  estimateDeviations: { title: string; estimate: number; actual: number }[];
  openIdeas: KnownIdea[];
  rejectedIdeas: KnownIdea[];
}

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max)} […]` : value);
const list = (lines: string[], empty: string): string => (lines.length ? lines.join('\n') : empty);

export function buildVisionaryPrompt(
  instructions: string,
  context: VisionaryContext,
  limit: number,
  focus: string | null = null,
): string {
  const bugs = Object.entries(context.bugsByCategory).map(
    ([group, items]) =>
      `### ${group} (${items.length})\n${items.map((bug) => `- [${bug.status} / ${bug.severity}] ${bug.title}`).join('\n')}`,
  );
  return [
    `Du bist der Agent "${VISIONARY_AUTHOR}". Du analysierst das Projekt nur lesend und schlägt höchstens ${limit} ` +
      'begründete Erweiterungsideen vor, die dem Projekt den grössten Nutzen bringen. Du änderst nichts, führst keine ' +
      'Befehle aus und legst nichts selbst an.',
    `## Anweisung\n${instructions || 'Schlage konkrete, umsetzbare Erweiterungen vor, die sich auf die Daten unten stützen.'}`,
    focus
      ? `## Schwerpunkt des Nutzers\n${focus}\n\nRichte die Vorschläge auf diesen Schwerpunkt aus. Auch hier gilt: Jede Idee muss sich auf die Daten unten stützen.`
      : '',
    `## Dokumentation (gekürzt)\n${list(
      context.docs.map((doc) => `### ${doc.path}\n${doc.text}`),
      'Keine README oder docs/*.md gefunden.',
    )}`,
    `## Dateibaum (ohne Inhalte)\n${list(context.fileTree, '(leer)')}`,
    `## Letzte Sprintberichte\n${list(
      context.sprintReports.map(
        (report) =>
          `### ${report.sprint}\n${clip(report.summary, 800)}${report.problems.length ? `\nProbleme: ${report.problems.join('; ')}` : ''}${report.missing.length ? `\nOffen: ${report.missing.join('; ')}` : ''}`,
      ),
      'Keine Sprintberichte.',
    )}`,
    `## Bugs der letzten 60 Tage nach Kategorie\n${list(bugs, 'Keine Bugs in den letzten 60 Tagen.')}`,
    `## Aufträge mit „Aktion notwendig“\n${list(
      context.actionTodos.map((item) => `- ${item.title}: ${clip(item.todo, 200)}`),
      'Keine.',
    )}`,
    `## Coverage je Bereich\n${list(
      context.coverage.map(
        (area) =>
          `- ${area.area}: Zeilen ${area.lines ?? '–'} %, Zweige ${area.branches ?? '–'} %, ${area.tests} Tests`,
      ),
      'Keine Coverage gemeldet.',
    )}`,
    `## Grösste Schätzabweichungen (Tokens geschätzt → tatsächlich)\n${list(
      context.estimateDeviations.map((item) => `- ${item.title}: ${item.estimate} → ${item.actual}`),
      'Keine Daten.',
    )}`,
    `## Offene Ideen (nicht erneut vorschlagen)\n${list(
      context.openIdeas.map((idea) => `- ${idea.title}`),
      'Keine.',
    )}`,
    `## Abgelehnte Ideen (nicht erneut vorschlagen, Ablehnungsgrund beachten)\n${list(
      context.rejectedIdeas.map(
        (idea) => `- ${idea.title} – Ablehnungsgrund: ${idea.rejectionReason?.trim() || 'keiner angegeben'}`,
      ),
      'Keine.',
    )}`,
    [
      '## Ausgabeformat',
      `Gib je Idee genau eine Zeile aus, höchstens ${limit} Zeilen, ohne Codeblock:`,
      `${IDEA_MARKER} {"title": "...", "category": "frontend|backend|fullstack|infrastructure|docs|security", "benefit": 0-10, ` +
        '"cost": 0-10, "priority": "low|medium|high", "reason": "Stützt sich auf …", "description": "..."}',
      'title: höchstens 60 Zeichen, sagt knapp, was entsteht. description: was umgesetzt wird (2–5 Sätze).',
      'reason: beginnt mit „Stützt sich auf“ und nennt konkrete Belege aus den Daten oben (Bug, Sprintbericht, ' +
        'Coverage-Wert, Schätzabweichung, Datei). Ideen ohne solchen Beleg werden verworfen.',
      'Schlage nichts vor, was einer offenen oder abgelehnten Idee entspricht.',
    ].join('\n'),
  ].join('\n\n');
}

const SKIPPED = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.angular',
  '.dev-log',
  '.next',
  'backups',
  'test-results',
  '.cache',
  '.turbo',
  '.venv',
]);
const MAX_TREE_ENTRIES = 400;
const MAX_TREE_DEPTH = 4;

/** Dateibaum relativ zum Projekt (ohne Inhalte, ohne Abhängigkeiten, Build-Ausgaben und Geheimnisse). */
export async function fileTree(root: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_TREE_DEPTH || result.length >= MAX_TREE_ENTRIES) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (result.length >= MAX_TREE_ENTRIES) {
        result.push('[… gekürzt]');
        return;
      }
      if (SKIPPED.has(entry.name) || /^\.env|\.(?:pem|key)$/i.test(entry.name)) continue;
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        result.push(`${path}/`);
        await walk(join(directory, entry.name), `${path}/`, depth + 1);
      } else result.push(path);
    }
  };
  await walk(root, '', 1);
  return result;
}

const MAX_DOC_BYTES = 1_000_000;

async function readDocs(root: string): Promise<VisionaryContext['docs']> {
  const paths = [
    'README.md',
    ...(await readdir(join(root, 'docs')).catch(() => [] as string[]))
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => `docs/${name}`),
  ];
  const docs: VisionaryContext['docs'] = [];
  let budget = 24_000;
  for (const path of paths) {
    if (budget <= 0) break;
    // Ohne Links zu folgen: docs/x.md -> ~/.zsh_history landete sonst im Prompt (ggf. bei einem Cloud-Modell).
    const file = await readProjectFile(root, path, MAX_DOC_BYTES);
    if (!file) continue;
    const content = file.content.toString('utf8');
    const text = clip(content.trim(), Math.min(4_000, budget));
    budget -= text.length;
    docs.push({ path, text });
  }
  return docs;
}

const rows = <R>(promise: Promise<{ rows: R[] }>): Promise<R[]> =>
  promise.then((result) => result.rows).catch(() => [] as R[]);

/** Bewusst gekürztes Kontextpaket: Doku, Dateibaum, Berichte, Bugs, Aktionen, Coverage, Schätzungen, Ideen. */
export async function loadVisionaryContext(pool: Pool, slug: string, cwd: string): Promise<VisionaryContext> {
  const [docs, tree, reports, bugs, todos, coverage, deviations, ideas] = await Promise.all([
    readDocs(cwd),
    fileTree(cwd),
    rows(
      pool.query<{ sprint: string; summary: string; problems: unknown; missing: unknown }>(
        `SELECT s.name AS sprint, r.summary, r.problems, r.missing FROM sprint_reports r JOIN sprints s ON s.id = r.sprint_id
          WHERE r.project_slug = $1 ORDER BY r.generated_at DESC LIMIT 3`,
        [slug],
      ),
    ),
    rows(
      pool.query<{ category: string | null; title: string; status: string; severity: string }>(
        `SELECT category, title, status, severity FROM bugs
          WHERE project_slug = $1 AND created_at > NOW() - INTERVAL '60 days' ORDER BY created_at DESC LIMIT 80`,
        [slug],
      ),
    ),
    rows(
      pool.query<{ title: string; todo: string }>(
        `SELECT title, action_todo AS todo FROM development_items
          WHERE project_slug = $1 AND NULLIF(TRIM(action_todo), '') IS NOT NULL ORDER BY updated_at DESC LIMIT 20`,
        [slug],
      ),
    ),
    rows(
      pool.query<{ area: string; lines: number | null; branches: number | null; tests: string }>(
        `SELECT DISTINCT ON (a.area) a.area, a.lines, a.branches,
                a.unit_tests + a.component_tests + a.integration_tests + a.e2e_tests AS tests
           FROM test_coverage_areas a JOIN test_coverage_reports r ON r.id = a.report_id
          WHERE r.project_slug = $1 ORDER BY a.area, r.created_at DESC`,
        [slug],
      ),
    ),
    rows(
      pool.query<{ title: string; estimate: string; actual: string }>(
        `SELECT d.title, d.token_estimate AS estimate, SUM(st.tokens) AS actual
           FROM development_items d JOIN agent_runs r ON r.development_id = d.id JOIN agent_run_steps st ON st.run_id = r.id
          WHERE d.project_slug = $1 AND d.token_estimate > 0
          GROUP BY d.id HAVING SUM(st.tokens) > 0
          ORDER BY ABS(LN(SUM(st.tokens)::float / d.token_estimate)) DESC LIMIT 5`,
        [slug],
      ),
    ),
    rows(
      pool.query<KnownIdea>(
        `SELECT id, title, status, rejection_reason AS "rejectionReason" FROM ideation_items
          WHERE project_slug = $1 AND status <> 'accepted' ORDER BY created_at DESC LIMIT 300`,
        [slug],
      ),
    ),
  ]);
  const bugsByCategory: VisionaryContext['bugsByCategory'] = {};
  for (const bug of bugs) {
    const group = bug.category ?? 'ohne Kategorie';
    (bugsByCategory[group] ??= []).push({ title: bug.title, status: bug.status, severity: bug.severity });
  }
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .map((entry) => (typeof entry === 'string' ? entry : ((entry as { title?: string })?.title ?? '')))
          .filter(Boolean)
          .slice(0, 8)
      : [];
  return {
    docs,
    fileTree: tree,
    sprintReports: reports.map((report) => ({
      sprint: report.sprint,
      summary: report.summary ?? '',
      problems: strings(report.problems),
      missing: strings(report.missing),
    })),
    bugsByCategory,
    actionTodos: todos,
    coverage: coverage.map((area) => ({ ...area, tests: Number(area.tests) })),
    estimateDeviations: deviations.map((row) => ({
      title: row.title,
      estimate: Number(row.estimate),
      actual: Number(row.actual),
    })),
    openIdeas: ideas.filter((idea) => idea.status !== 'rejected'),
    rejectedIdeas: ideas.filter((idea) => idea.status === 'rejected'),
  };
}

export interface StoreResult {
  created: { id: string; title: string }[];
  /** Verworfen: kaputte Zeilen, ohne Beleg, Dubletten und alles über dem Limit. */
  discarded: number;
  /** Treffer auf offene Ideen, an die ein Kommentar gehängt wurde. */
  commented: number;
}

const evidence = (idea: VisionaryIdea): string =>
  [
    `**Belege:** ${idea.reason}`,
    `Nutzen ${idea.benefit ?? '–'}/10 · Kosten ${idea.cost ?? '–'}/10 · Priorität ${idea.priority}`,
  ].join('\n\n');

/** Legt die Ideen an (höchstens `limit`), verwirft Dubletten und kommentiert Treffer auf offene Ideen. */
export async function storeVisionaryIdeas(
  pool: Pool,
  slug: string,
  parsed: ParsedIdeas,
  known: KnownIdea[],
  limit: number,
): Promise<StoreResult> {
  const result: StoreResult = { created: [], discarded: parsed.discarded.length, commented: 0 };
  const seen = [...known];
  for (const idea of parsed.ideas) {
    const duplicate = findDuplicate(idea.title, seen);
    if (duplicate) {
      result.discarded += 1;
      if (duplicate.status !== 'rejected' && known.includes(duplicate)) {
        await pool.query(
          `INSERT INTO ideation_comments (ideation_id, author, author_kind, body) VALUES ($1, $2, 'agent', $3)`,
          [
            duplicate.id,
            VISIONARY_AUTHOR,
            `Der Visionär hat Ähnliches vorgeschlagen: „${idea.title}“.\n\n${evidence(idea)}`.slice(0, 4000),
          ],
        );
        result.commented += 1;
      }
      continue;
    }
    if (result.created.length >= limit) {
      result.discarded += 1;
      continue;
    }
    const row = (
      await pool.query<{ id: string }>(
        `INSERT INTO ideation_items (project_slug, title, description, status, priority, benefit, cost, category,
                                     agent_note, source)
         VALUES ($1, $2, $3, 'idea', $4, $5, $6, $7, $8, 'visionary') RETURNING id`,
        [slug, idea.title, idea.description, idea.priority, idea.benefit, idea.cost, idea.category, idea.reason],
      )
    ).rows[0];
    if (!row) continue;
    await pool.query(
      `INSERT INTO ideation_comments (ideation_id, author, author_kind, body) VALUES ($1, $2, 'agent', $3)`,
      [row.id, VISIONARY_AUTHOR, evidence(idea).slice(0, 4000)],
    );
    result.created.push({ id: row.id, title: idea.title });
    seen.push({ id: row.id, title: idea.title, status: 'idea' });
  }
  return result;
}

/** Antwort des Visionärs im Dashboard-Chat (Lauf wurde dort mit @Visionär gestartet). */
async function replyInChat(pool: Pool, project: string, content: string): Promise<void> {
  await pool
    .query(`INSERT INTO chat_messages (project_slug, role, content, agent_name) VALUES ($1, 'assistant', $2, $3)`, [
      project,
      content,
      VISIONARY_AUTHOR,
    ])
    .catch((error: unknown) => console.error('Visionär-Antwort im Chat fehlgeschlagen:', error));
}

/** Fordert einen Lauf an; null, wenn für das Projekt schon einer angefragt ist oder läuft. */
export async function requestVisionaryRun(
  pool: Pool,
  slug: string,
  requestedBy: string,
  options: { focus?: string | null; replyInChat?: boolean } = {},
): Promise<string | null> {
  const row = (
    await pool.query<{ id: string }>(
      `INSERT INTO visionary_runs (project_slug, requested_by, focus, reply_in_chat) VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_slug) WHERE status IN ('requested', 'running') DO NOTHING RETURNING id`,
      [slug, requestedBy.slice(0, 80), options.focus?.trim().slice(0, 1000) || null, options.replyInChat ?? false],
    )
  ).rows[0];
  return row?.id ?? null;
}

const CANCEL_POLL_MS = 2_000;

async function setProgress(pool: Pool, runId: string, message: string): Promise<void> {
  await pool
    .query(`UPDATE visionary_runs SET progress = $2 WHERE id = $1 AND status = 'running'`, [
      runId,
      message.slice(0, 300),
    ])
    .catch(logged('visionary'));
}

/**
 * Arbeitet einen angefragten Lauf des Projekts ab: Kontext sammeln, Visionär (nur lesen) befragen, Ideen anlegen,
 * Push senden. Ein Abbruch über die Oberfläche beendet den Agent; dann wird nichts angelegt.
 */
export async function processVisionaryRun(
  pool: Pool,
  options: Pick<RunnerOptions, 'project' | 'cwd' | 'timeoutMs'>,
  execute: CommandExecutor = runCommand,
): Promise<number> {
  const run = (
    await pool.query<{ id: string; focus: string | null; replyInChat: boolean }>(
      `UPDATE visionary_runs SET status = 'running', started_at = NOW(), progress = 'Sammelt den Projektkontext …'
        WHERE id = (SELECT id FROM visionary_runs WHERE project_slug = $1 AND status = 'requested'
                     ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, focus, reply_in_chat AS "replyInChat"`,
      [options.project],
    )
  ).rows[0];
  if (!run) return 0;
  const controller = new AbortController();
  const watcher = setInterval(() => {
    void pool
      .query<{ status: string }>('SELECT status FROM visionary_runs WHERE id = $1', [run.id])
      .then((result) => {
        if (result.rows[0]?.status !== 'running') controller.abort();
      })
      .catch(logged('visionary'));
  }, CANCEL_POLL_MS);
  try {
    const [context, limit] = await Promise.all([
      loadVisionaryContext(pool, options.project, options.cwd),
      readVisionaryLimit(pool),
    ]);
    await setProgress(pool, run.id, 'Der Visionär liest das Projekt …');
    const { exitCode, output } = await runAuthorAgent(
      pool,
      options,
      (instructions) => buildVisionaryPrompt(instructions, context, limit, run.focus),
      execute,
      VISIONARY_ROLE,
      (message) => void setProgress(pool, run.id, message),
      undefined,
      undefined,
      controller.signal,
    );
    if (controller.signal.aborted || isShuttingDown()) {
      // Beim Beenden des Workers wird der Lauf erneut angefragt; ein Abbruch durch den Nutzer bleibt abgebrochen.
      await pool.query(
        `UPDATE visionary_runs SET status = 'requested', started_at = NULL, progress = NULL
          WHERE id = $1 AND status = 'running'`,
        [run.id],
      );
      return 0;
    }
    const parsed = parseIdeaLines(output);
    if (exitCode !== 0 && !parsed.ideas.length) {
      throw new Error(output.slice(-600) || 'Der Visionär hat keine Antwort geliefert.');
    }
    await setProgress(pool, run.id, 'Prüft Dubletten und legt Ideen an …');
    const stored = await storeVisionaryIdeas(
      pool,
      options.project,
      parsed,
      [...context.openIdeas, ...context.rejectedIdeas],
      limit,
    );
    await pool.query(
      `UPDATE visionary_runs SET status = 'done', finished_at = NOW(), progress = NULL,
              created_count = $2, discarded_count = $3 WHERE id = $1`,
      [run.id, stored.created.length, stored.discarded],
    );
    const count = stored.created.length;
    if (run.replyInChat) {
      await replyInChat(
        pool,
        options.project,
        count
          ? `Ich habe ${count} neue ${count === 1 ? 'Idee' : 'Ideen'} in Ideation angelegt${
              stored.discarded ? ` (${stored.discarded} verworfen: Dubletten, ohne Beleg oder über dem Limit)` : ''
            }:\n\n${stored.created.map((idea) => `- ${idea.title}`).join('\n')}\n\nDu findest sie unter Ideation mit dem Badge „Visionär“ – dort lassen sie sich übernehmen oder mit Grund ablehnen.`
          : `Ich habe keine neuen Ideen angelegt (${stored.discarded} verworfen: Dubletten, ohne Beleg oder über dem Limit).`,
      );
    }
    await sendPush(
      pool,
      {
        title: `💡 ${count} neue ${count === 1 ? 'Idee' : 'Ideen'} vom Visionär · ${options.project}`,
        body: count
          ? stored.created.map((idea) => idea.title).join(' · ')
          : `Keine neuen Ideen (${stored.discarded} verworfen).`,
        url: `#ideation?project=${encodeURIComponent(options.project)}`,
        tag: `visionary-${run.id}`,
      },
      { project: options.project },
    ).catch((error: unknown) => console.error('Visionär-Meldung konnte nicht gesendet werden:', error));
    return count;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    await pool.query(
      `UPDATE visionary_runs SET status = 'failed', finished_at = NOW(), progress = NULL, error = $2
        WHERE id = $1 AND status = 'running'`,
      [run.id, message],
    );
    if (run.replyInChat)
      await replyInChat(pool, options.project, `Der Lauf ist fehlgeschlagen: ${message.slice(0, 500)}`);
    return 0;
  } finally {
    clearInterval(watcher);
  }
}
