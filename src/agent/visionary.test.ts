import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { decodePolicy, guardProblem } from './agent-guard.js';
import { READ_ONLY_ROLES, roleDefaultCommands, withAgentPermissions } from './tool-permissions.js';
import {
  buildVisionaryPrompt,
  clampLimit,
  DEFAULT_VISIONARY_LIMIT,
  findDuplicate,
  type KnownIdea,
  loadVisionaryContext,
  MAX_VISIONARY_LIMIT,
  normalizeTitle,
  parseIdeaLines,
  readVisionaryLimit,
  storeVisionaryIdeas,
  titleSimilarity,
  VISIONARY_AUTHOR,
  type VisionaryContext,
} from './visionary.js';

const line = (fields: Record<string, unknown>): string => `@@IDEA ${JSON.stringify(fields)}`;
const idea = (title: string, extra: Record<string, unknown> = {}): string =>
  line({
    title,
    category: 'backend',
    benefit: 7,
    cost: 3,
    priority: 'hoch',
    reason: 'Stützt sich auf 4 Bugs der Kategorie backend in den letzten 60 Tagen.',
    description: 'Was entsteht.',
    ...extra,
  });

test('Visionär-Parser: liest @@IDEA-Zeilen zwischen Fliesstext und normalisiert die Felder', () => {
  const parsed = parseIdeaLines(
    [
      'Ich habe das Projekt angesehen. Hier meine Vorschläge:',
      idea('Export als CSV', { category: 'API', benefit: '12', priority: 'unbekannt' }),
      '  - ' + idea('Dunkles Farbschema', { category: 'Raumfahrt' }),
      'Fazit: viel Potenzial.',
    ].join('\n'),
  );
  assert.equal(parsed.discarded.length, 0);
  assert.equal(parsed.ideas.length, 2);
  assert.deepEqual(parsed.ideas[0], {
    title: 'Export als CSV',
    category: 'backend',
    benefit: 10,
    cost: 3,
    priority: 'medium',
    reason: 'Stützt sich auf 4 Bugs der Kategorie backend in den letzten 60 Tagen.',
    description: 'Was entsteht.',
  });
  assert.equal(parsed.ideas[1]!.category, null, 'unbekannte Kategorie wird zu „ohne Kategorie“');
});

test('Visionär-Parser: kaputtes JSON und Begründungen ohne Datenbezug legen keine Idee an', () => {
  const parsed = parseIdeaLines(
    [
      '@@IDEA {"title": "Halb fertig", "reason": "Stützt sich auf',
      '@@IDEA kein json',
      '@@IDEA ["liste"]',
      idea('Ohne Beleg', { reason: 'Wäre einfach schön.' }),
      idea('Floskel', { reason: 'Stützt sich auf allgemeine Best Practices.' }),
      idea('', {}),
      idea('Mit Beleg'),
    ].join('\n'),
  );
  assert.deepEqual(
    parsed.ideas.map((entry) => entry.title),
    ['Mit Beleg'],
  );
  assert.equal(parsed.discarded.length, 6);
  assert.match(parsed.discarded[0]!.problem, /JSON/);
  assert.match(parsed.discarded[3]!.problem, /Datenbezug/);
  assert.match(parsed.discarded[4]!.problem, /Datenbezug/);
  assert.match(parsed.discarded[5]!.problem, /Titel/);
});

test('Dubletten: normalisierte Titel und Trigramm-/Wort-Ähnlichkeit', () => {
  assert.equal(normalizeTitle('Die Übersicht für Bugs!'), 'uebersicht bugs');
  assert.equal(titleSimilarity('CSV-Export für Aufträge', 'csv export fuer auftraege'), 1);
  assert.ok(titleSimilarity('CSV-Export der Aufträge', 'Aufträge als CSV exportieren') >= 0.55);
  assert.ok(titleSimilarity('Dunkles Farbschema', 'Push-Meldungen für Bugs') < 0.3);
  const known: KnownIdea[] = [
    { id: '1', title: 'Push-Meldungen für Bugs', status: 'idea' },
    { id: '2', title: 'CSV-Export der Aufträge', status: 'rejected' },
  ];
  assert.equal(findDuplicate('Aufträge als CSV exportieren', known)?.id, '2');
  assert.equal(findDuplicate('Neue Push-Meldung für Bugs', known)?.id, '1');
  assert.equal(findDuplicate('Dunkles Farbschema', known), null);
});

test('Limit: Standard 5, höchstens 8, ungültige Werte fallen auf den Standard', async () => {
  assert.equal(clampLimit(undefined), DEFAULT_VISIONARY_LIMIT);
  assert.equal(clampLimit('3'), 3);
  assert.equal(clampLimit(20), MAX_VISIONARY_LIMIT);
  assert.equal(clampLimit(0), DEFAULT_VISIONARY_LIMIT);
  assert.equal(clampLimit('abc'), DEFAULT_VISIONARY_LIMIT);
  const pool = { query: async () => ({ rows: [{ value: '12' }] }) } as unknown as Pool;
  assert.equal(await readVisionaryLimit(pool), 8);
});

/** Merkt sich angelegte Ideen und Kommentare. */
function storePool() {
  const ideas: unknown[][] = [];
  const comments: unknown[][] = [];
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      if (sql.includes('INSERT INTO ideation_items')) {
        ideas.push(values);
        return { rows: [{ id: `neu-${ideas.length}` }] };
      }
      if (sql.includes('INSERT INTO ideation_comments')) comments.push(values);
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, ideas, comments };
}

test('Ablage: höchstens N Ideen, Dubletten verworfen, Treffer auf offene Ideen kommentiert', async () => {
  const { pool, ideas, comments } = storePool();
  const known: KnownIdea[] = [
    { id: 'offen', title: 'Push-Meldungen für Bugs', status: 'considering' },
    { id: 'abgelehnt', title: 'Dunkles Farbschema', status: 'rejected', rejectionReason: 'Kein Bedarf' },
  ];
  const parsed = parseIdeaLines(
    [
      idea('Push-Meldung für Bugs'),
      idea('Dunkles Farbschema'),
      idea('Export als CSV'),
      idea('Export als CSV-Datei'),
      idea('Suche über alle Projekte'),
      idea('Zeiterfassung je Auftrag'),
      '@@IDEA {kaputt',
    ].join('\n'),
  );
  const result = await storeVisionaryIdeas(pool, 'p', parsed, known, 2);
  assert.deepEqual(
    result.created.map((entry) => entry.title),
    ['Export als CSV', 'Suche über alle Projekte'],
  );
  // kaputt + 2 Dubletten zu bekannten + 1 Dublette im selben Lauf + 1 über dem Limit
  assert.equal(result.discarded, 5);
  assert.equal(result.commented, 1);
  assert.equal(ideas.length, 2);
  const [slug, title, description, priority, benefit, cost, category, note] = ideas[0]!;
  assert.deepEqual(
    [slug, title, description, priority, benefit, cost, category],
    ['p', 'Export als CSV', 'Was entsteht.', 'high', 7, 3, 'backend'],
  );
  assert.match(String(note), /^Stützt sich auf/);
  // Ein Kommentar an die offene Idee, je angelegter Idee ein Kommentar mit den Belegen; nichts an der abgelehnten.
  assert.deepEqual(
    comments.map((values) => values[0]),
    ['offen', 'neu-1', 'neu-2'],
  );
  assert.ok(comments.every((values) => values[1] === VISIONARY_AUTHOR));
  assert.ok(comments.every((values) => /Belege:\*\* Stützt sich auf/.test(String(values[2]))));
});

test('Ablage: legt Ideen mit Status idea und Herkunft visionary an', async () => {
  const sql: string[] = [];
  const pool = {
    query: async (text: string) => {
      sql.push(text);
      return { rows: [{ id: 'x' }] };
    },
  } as unknown as Pool;
  await storeVisionaryIdeas(pool, 'p', parseIdeaLines(idea('Export als CSV')), [], 5);
  assert.match(sql[0]!, /VALUES \(\$1, \$2, \$3, 'idea', .*'visionary'\)/s);
});

const emptyContext: VisionaryContext = {
  docs: [],
  fileTree: [],
  sprintReports: [],
  bugsByCategory: {},
  actionTodos: [],
  coverage: [],
  estimateDeviations: [],
  openIdeas: [],
  rejectedIdeas: [],
};

test('Ablehnungskreislauf: der nächste Prompt enthält Titel und Ablehnungsgrund abgelehnter Ideen', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'visionary-'));
  const pool = {
    query: async (sql: string) =>
      sql.includes('FROM ideation_items')
        ? {
            rows: [
              { id: '1', title: 'Dunkles Farbschema', status: 'rejected', rejectionReason: 'Kein Bedarf im Team' },
              { id: '2', title: 'Push-Meldungen für Bugs', status: 'idea', rejectionReason: null },
            ],
          }
        : { rows: [] },
  } as unknown as Pool;
  const context = await loadVisionaryContext(pool, 'p', cwd);
  assert.deepEqual(
    context.rejectedIdeas.map((entry) => entry.title),
    ['Dunkles Farbschema'],
  );
  const prompt = buildVisionaryPrompt('', context, 5);
  assert.match(prompt, /Dunkles Farbschema – Ablehnungsgrund: Kein Bedarf im Team/);
  assert.match(prompt, /## Offene Ideen[^#]*Push-Meldungen für Bugs/);
  assert.match(prompt, /höchstens 5/);
  assert.match(prompt, /@@IDEA \{"title"/);
});

test('Kontextpaket: Bugs nach Kategorie, Coverage, Schätzabweichungen und Dateibaum statt Inhalten', () => {
  const prompt = buildVisionaryPrompt(
    'Fokus auf Stabilität.',
    {
      ...emptyContext,
      fileTree: ['src/', 'src/app.ts'],
      bugsByCategory: { backend: [{ title: 'Login hängt', status: 'open', severity: 'high' }] },
      coverage: [{ area: 'backend', lines: 61, branches: 40, tests: 120 }],
      estimateDeviations: [{ title: 'Export', estimate: 1000, actual: 9000 }],
      actionTodos: [{ title: 'Deploy', todo: 'Schlüssel hinterlegen' }],
    },
    3,
  );
  assert.match(prompt, /Fokus auf Stabilität\./);
  assert.match(prompt, /### backend \(1\)\n- \[open \/ high\] Login hängt/);
  assert.match(prompt, /- backend: Zeilen 61 %, Zweige 40 %, 120 Tests/);
  assert.match(prompt, /- Export: 1000 → 9000/);
  assert.match(prompt, /- Deploy: Schlüssel hinterlegen/);
  assert.match(prompt, /src\/app\.ts/);
});

test('Rechte: der Visionär darf nur lesen – keine Datei-Werkzeuge, keine Befehle', () => {
  assert.ok(READ_ONLY_ROLES.has('visionary'));
  const permissions = { enabled: null, custom: [] };
  assert.deepEqual(roleDefaultCommands('visionary', permissions), []);
  // Auch eine eigene Zuweisung am Agent gibt ihm keine Rechte.
  const command = withAgentPermissions(['claude', '-p', '{prompt}'], 'visionary', permissions, [
    'files',
    'Bash(git status:*)',
  ]);
  const disallowed = command[command.indexOf('--disallowedTools') + 1] ?? '';
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']) {
    assert.ok(disallowed.split(',').includes(tool), tool);
  }
  assert.equal(command.includes('--allowedTools'), false);
  const settings = command[command.indexOf('--settings') + 1];
  if (settings) {
    const hook = (JSON.parse(settings) as { hooks: { PreToolUse: { hooks: { command: string }[] }[] } }).hooks
      .PreToolUse[0]!.hooks[0]!.command;
    const policy = decodePolicy(/agent-guard\.ts' '([\w-]+)'/.exec(hook)?.[1]);
    assert.deepEqual(policy, { create: false, edit: false, shell: false, scopes: [] });
    const root = mkdtempSync(join(tmpdir(), 'visionary-guard-'));
    assert.match(
      guardProblem({ tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: root }, policy, root) ?? '',
      /nur lesen/,
    );
    assert.ok(guardProblem({ tool_name: 'Write', tool_input: { file_path: 'x.md' }, cwd: root }, policy, root));
  }
});
