import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import type { Pool } from 'pg';
import type { CommandExecutor } from '../core/command.js';
import { decodePolicy, guardProblem } from './agent-guard.js';
import { READ_ONLY_ROLES, roleDefaultCommands, withAgentPermissions } from './tool-permissions.js';
import {
  buildVisionaryPrompt,
  clampLimit,
  DEFAULT_VISIONARY_LIMIT,
  fileTree,
  findDuplicate,
  hasDataReference,
  type KnownIdea,
  loadVisionaryContext,
  MAX_VISIONARY_LIMIT,
  normalizeTitle,
  parseIdeaLines,
  processVisionaryRun,
  readVisionaryLimit,
  requestVisionaryRun,
  storeVisionaryIdeas,
  titleSimilarity,
  VISIONARY_AUTHOR,
  type VisionaryContext,
} from './visionary.js';

/** Temp-Ordner dieser Datei; werden am Ende immer entfernt. */
const temporary: string[] = [];
const tempDir = (prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(directory);
  return directory;
};
after(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

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
  const cwd = tempDir('visionary-');
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
    const root = tempDir('visionary-guard-');
    assert.match(
      guardProblem({ tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: root }, policy, root) ?? '',
      /nur lesen/,
    );
    assert.ok(guardProblem({ tool_name: 'Write', tool_input: { file_path: 'x.md' }, cwd: root }, policy, root));
  }
});

test('Datenbezug: „stützt sich auf“ mit konkreter Angabe, keine Floskeln', () => {
  assert.ok(hasDataReference('Stützt sich auf 3 offene Bugs der Kategorie frontend.'));
  assert.ok(hasDataReference('Die Idee stützt sich auf den Sprintbericht von Sprint 4.'));
  for (const reason of [
    '',
    'Wäre nützlich.',
    'Stützt sich auf Daten.',
    'Stützt sich auf bewährte Praxis im Team.',
    'Stützt sich auf best practices der Branche.',
    'Stützt sich auf meine Erfahrung mit Projekten.',
  ]) {
    assert.equal(hasDataReference(reason), false, reason);
  }
});

test('Visionär-Parser: Grenzwerte und ungültige Felder', () => {
  const parsed = parseIdeaLines(
    [
      idea('Grenzen', { benefit: -3, cost: 10.6, priority: 'NIEDRIG', category: 'Doku', description: 42 }),
      idea('Text statt Zahl', { benefit: 'viel', cost: null, priority: 7, category: 5, description: '  Mit Rand.  ' }),
      idea('ab'),
      idea('„Zitat“', {}),
      line({ title: 'Ohne Begründung' }),
      '@@IDEA {"title": "Klammer"} } zuviel',
      '@@IDEA ohne Klammer }',
      '@@IDEA null',
    ].join('\r\n'),
  );
  assert.deepEqual(
    parsed.ideas.map(({ title, benefit, cost, priority, category, description }) => ({
      title,
      benefit,
      cost,
      priority,
      category,
      description,
    })),
    [
      { title: 'Grenzen', benefit: 0, cost: 10, priority: 'low', category: 'docs', description: '' },
      {
        title: 'Text statt Zahl',
        benefit: null,
        cost: null,
        priority: 'medium',
        category: null,
        description: 'Mit Rand.',
      },
      { title: 'Zitat', benefit: 7, cost: 3, priority: 'high', category: 'backend', description: 'Was entsteht.' },
    ],
  );
  assert.deepEqual(
    parsed.discarded.map((entry) => entry.problem),
    // Erst die Zeilen ohne gültiges JSON (parseMarkerLines), dann die inhaltlich verworfenen.
    [
      'Kein gültiges JSON.',
      'Kein gültiges JSON.',
      'Kein gültiges JSON.',
      'Titel fehlt.',
      'Begründung ohne konkreten Datenbezug („stützt sich auf …“).',
    ],
  );
  assert.deepEqual(parseIdeaLines(''), { ideas: [], discarded: [] });
  assert.deepEqual(parseIdeaLines('Nur Fliesstext ohne Marker.'), { ideas: [], discarded: [] });
});

test('Dubletten: leere Titel sind nie ähnlich, die ähnlichste Idee gewinnt', () => {
  assert.equal(titleSimilarity('', 'Export'), 0);
  assert.equal(titleSimilarity('der die das', 'Export'), 0, 'nur Füllwörter');
  const known: KnownIdea[] = [
    { id: 'a', title: 'CSV-Export', status: 'idea' },
    { id: 'b', title: 'CSV-Export für Aufträge', status: 'idea' },
  ];
  assert.equal(findDuplicate('CSV-Export der Aufträge', known)?.id, 'b');
  assert.equal(findDuplicate('CSV-Export', []), null);
});

test('Limit: nicht lesbare Einstellung fällt auf den Standard', async () => {
  const failing = { query: async () => Promise.reject(new Error('DB weg')) } as unknown as Pool;
  assert.equal(await readVisionaryLimit(failing), DEFAULT_VISIONARY_LIMIT);
  const empty = { query: async () => ({ rows: [] }) } as unknown as Pool;
  assert.equal(await readVisionaryLimit(empty), DEFAULT_VISIONARY_LIMIT);
  assert.equal(clampLimit(2.5), DEFAULT_VISIONARY_LIMIT);
  assert.equal(clampLimit(1), 1);
  assert.equal(clampLimit(MAX_VISIONARY_LIMIT), MAX_VISIONARY_LIMIT);
});

test('Prompt: Schwerpunkt, Sprintberichte, fehlende Werte und leere Abschnitte', () => {
  const prompt = buildVisionaryPrompt(
    '',
    {
      ...emptyContext,
      docs: [{ path: 'README.md', text: 'Dev Log' }],
      sprintReports: [
        { sprint: 'Sprint 4', summary: 'x'.repeat(900), problems: ['CI rot'], missing: ['Export'] },
        { sprint: 'Sprint 3', summary: 'Ruhig.', problems: [], missing: [] },
      ],
      coverage: [{ area: 'frontend', lines: null, branches: null, tests: 0 }],
      rejectedIdeas: [{ id: '1', title: 'Chat-Bot', status: 'rejected', rejectionReason: '  ' }],
    },
    2,
    'Stabilität vor neuen Funktionen',
  );
  assert.match(prompt, /## Anweisung\nSchlage konkrete, umsetzbare Erweiterungen vor/);
  assert.match(prompt, /## Schwerpunkt des Nutzers\nStabilität vor neuen Funktionen/);
  assert.match(prompt, /### README\.md\nDev Log/);
  assert.match(prompt, /### Sprint 4\nx{800} \[…\]\nProbleme: CI rot\nOffen: Export/);
  assert.match(prompt, /### Sprint 3\nRuhig\.\n\n## Bugs/);
  assert.match(prompt, /- frontend: Zeilen – %, Zweige – %, 0 Tests/);
  assert.match(prompt, /- Chat-Bot – Ablehnungsgrund: keiner angegeben/);
  assert.match(prompt, /Keine Bugs in den letzten 60 Tagen\./);
  assert.match(prompt, /## Dateibaum \(ohne Inhalte\)\n\(leer\)/);
  assert.match(prompt, /höchstens 2 Zeilen/);

  const plain = buildVisionaryPrompt('', emptyContext, 5);
  assert.doesNotMatch(plain, /Schwerpunkt/);
  assert.match(plain, /Keine README oder docs\/\*\.md gefunden\./);
  assert.match(plain, /Keine Sprintberichte\./);
  assert.match(plain, /Keine Coverage gemeldet\./);
});

test('Dateibaum: sortiert, ohne Abhängigkeiten und Geheimnisse, höchstens vier Ebenen', async () => {
  const root = tempDir('visionary-tree-');
  mkdirSync(join(root, 'a', 'b', 'c', 'd', 'e'), { recursive: true });
  writeFileSync(join(root, 'a', 'b', 'c', 'd', 'e', 'tief.txt'), 'x');
  writeFileSync(join(root, 'a', 'b', 'c', 'd', 'vier.txt'), 'x');
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
  mkdirSync(join(root, '.git'));
  for (const name of ['.env', '.env.local', 'server.pem', 'id.key', 'README.md', 'B.md']) {
    writeFileSync(join(root, name), 'x');
  }
  // Der Inhalt der vierten Ordnerebene (a/b/c/d/…) wird nicht mehr gelesen.
  assert.deepEqual(await fileTree(root), ['a/', 'a/b/', 'a/b/c/', 'a/b/c/d/', 'B.md', 'README.md']);
  assert.deepEqual(await fileTree(join(root, 'gibt-es-nicht')), []);
});

test('Dateibaum: nach 400 Einträgen gekürzt', async () => {
  const root = tempDir('visionary-many-');
  for (let index = 0; index < 405; index += 1) writeFileSync(join(root, `f${String(index).padStart(3, '0')}.txt`), '');
  const tree = await fileTree(root);
  assert.equal(tree.length, 401);
  assert.equal(tree.at(-1), '[… gekürzt]');
});

test('Kontextpaket: Doku mit Budget, Berichte, Bugs je Kategorie, Coverage und Abweichungen', async () => {
  const cwd = tempDir('visionary-context-');
  mkdirSync(join(cwd, 'docs'));
  for (let index = 1; index <= 7; index += 1) writeFileSync(join(cwd, 'docs', `0${index}.md`), 'd'.repeat(5000));
  writeFileSync(join(cwd, 'docs', 'notiz.txt'), 'ignoriert');
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('FROM sprint_reports'))
        return {
          rows: [{ sprint: 'S1', summary: null, problems: ['A', { title: 'B' }, {}, null], missing: 'kein Array' }],
        };
      if (sql.includes('FROM bugs'))
        return {
          rows: [
            { category: null, title: 'Ohne', status: 'open', severity: 'low' },
            { category: 'backend', title: 'Eins', status: 'open', severity: 'high' },
            { category: 'backend', title: 'Zwei', status: 'fixed', severity: 'low' },
          ],
        };
      if (sql.includes('action_todo')) return { rows: [{ title: 'Deploy', todo: 'Schlüssel' }] };
      if (sql.includes('test_coverage_areas')) return { rows: [{ area: 'api', lines: 70, branches: 50, tests: '12' }] };
      if (sql.includes('AS actual')) return { rows: [{ title: 'Export', estimate: '1000', actual: '5000' }] };
      throw new Error('Tabelle fehlt');
    },
  } as unknown as Pool;
  const context = await loadVisionaryContext(pool, 'p', cwd);
  assert.deepEqual(
    context.docs.map((doc) => doc.path),
    ['docs/01.md', 'docs/02.md', 'docs/03.md', 'docs/04.md', 'docs/05.md', 'docs/06.md'],
    'ohne README, nur .md, bis das Budget aufgebraucht ist',
  );
  assert.equal(context.docs[0]!.text.length, 4000 + ' […]'.length);
  assert.ok(context.docs[5]!.text.length < context.docs[0]!.text.length);
  assert.deepEqual(context.sprintReports, [{ sprint: 'S1', summary: '', problems: ['A', 'B'], missing: [] }]);
  assert.deepEqual(Object.keys(context.bugsByCategory), ['ohne Kategorie', 'backend']);
  assert.equal(context.bugsByCategory.backend!.length, 2);
  assert.deepEqual(context.actionTodos, [{ title: 'Deploy', todo: 'Schlüssel' }]);
  assert.deepEqual(context.coverage, [{ area: 'api', lines: 70, branches: 50, tests: 12 }]);
  assert.deepEqual(context.estimateDeviations, [{ title: 'Export', estimate: 1000, actual: 5000 }]);
  // Eine fehlgeschlagene Abfrage (Ideen) liefert einfach nichts.
  assert.deepEqual([context.openIdeas, context.rejectedIdeas], [[], []]);
  assert.ok(context.fileTree.includes('docs/notiz.txt'));
});

test('Ablage: ohne zurückgegebene ID wird die Idee übersprungen', async () => {
  const comments: unknown[] = [];
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      if (sql.includes('INSERT INTO ideation_comments')) comments.push(values);
      return { rows: [] };
    },
  } as unknown as Pool;
  const result = await storeVisionaryIdeas(pool, 'p', parseIdeaLines(idea('Export als CSV')), [], 5);
  assert.deepEqual(result, { created: [], discarded: 0, commented: 0 });
  assert.equal(comments.length, 0);
});

test('Lauf anfordern: höchstens einer je Projekt, Schwerpunkt bereinigt', async () => {
  const calls: unknown[][] = [];
  const pool = (rows: unknown[]) =>
    ({
      query: async (_sql: string, values: unknown[]) => {
        calls.push(values);
        return { rows };
      },
    }) as unknown as Pool;
  assert.equal(
    await requestVisionaryRun(pool([{ id: 'r1' }]), 'p', 'a'.repeat(100), { focus: '  Tests  ', replyInChat: true }),
    'r1',
  );
  assert.deepEqual(calls[0], ['p', 'a'.repeat(80), 'Tests', true]);
  assert.equal(await requestVisionaryRun(pool([]), 'p', 'anna', { focus: '   ' }), null, 'läuft schon');
  assert.deepEqual(calls[1], ['p', 'anna', null, false]);
  await requestVisionaryRun(pool([]), 'p', 'anna');
  assert.deepEqual(calls[2], ['p', 'anna', null, false]);
});

// ---------------------------------------------------------------------------------------------------------------
// processVisionaryRun: Ablauf mit Fake-Datenbank und Fake-CLI (kein Prozess, kein Netzwerk).
// ---------------------------------------------------------------------------------------------------------------

type Answer = unknown[] | Error | ((values: unknown[]) => unknown[]);

function runPool(
  overrides: [RegExp, Answer][] = [],
  run: unknown = { id: 'r1', focus: 'Stabilität', replyInChat: true },
) {
  const queries: { sql: string; values: unknown[] }[] = [];
  let created = 0;
  const answers: [RegExp, Answer][] = [
    ...overrides,
    [/SET status = 'running'/, run ? [run] : []],
    [/FROM ideation_items/, [{ id: 'offen', title: 'Push-Meldungen für Bugs', status: 'idea', rejectionReason: null }]],
    [/FROM app_settings/, [{ value: '2' }]],
    [/INSERT INTO ideation_items/, () => [{ id: `neu-${++created}` }]],
    [
      /FROM agents\b/,
      [{ instructions: '', command: ['claude', '-p', '{prompt}'], allowedCommands: null, fileScope: [] }],
    ],
  ];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      const answer = answers.find(([pattern]) => pattern.test(sql))?.[1] ?? [];
      if (answer instanceof Error) throw answer;
      return { rows: typeof answer === 'function' ? answer(values) : answer };
    },
  } as unknown as Pool;
  return { pool, find: (pattern: RegExp) => queries.filter((query) => pattern.test(query.sql)) };
}

/** Fake der Claude-CLI: liefert Text und Exit-Code als stream-json, startet nichts. */
function fakeClaude(text: string, exitCode = 0, before?: () => Promise<void>) {
  const prompts: string[] = [];
  const execute: CommandExecutor = async (command, _cwd, options) => {
    prompts.push(command.at(-1) ?? '');
    options?.onSpawn?.(4242);
    await before?.();
    options?.onChunk?.(JSON.stringify({ type: 'result', result: text, is_error: false }));
    return { exitCode, durationMs: 1, output: '' };
  };
  return { prompts, execute };
}

/** Leerer Projektordner: der Lauf liest Doku und Dateibaum nur von hier. */
const runOptions = { project: 'p', cwd: tempDir('visionary-run-'), timeoutMs: 1000 };

test('Visionär-Lauf: ohne angefragten Lauf passiert nichts', async () => {
  const { pool, find } = runPool([], null);
  const { prompts, execute } = fakeClaude('egal');
  assert.equal(await processVisionaryRun(pool, runOptions, execute), 0);
  assert.equal(prompts.length, 0);
  assert.equal(find(/visionary_runs SET status = 'done'/).length, 0);
});

test('Visionär-Lauf: legt Ideen bis zum Limit an, kommentiert Dubletten und antwortet im Chat', async () => {
  const { pool, find } = runPool();
  const { prompts, execute } = fakeClaude(
    [
      'Meine Vorschläge:',
      idea('Push-Meldung für Bugs'),
      idea('Export als CSV'),
      idea('Suche über alle Projekte'),
      idea('Zeiterfassung je Auftrag'),
      '@@IDEA {kaputt',
    ].join('\n'),
  );
  assert.equal(await processVisionaryRun(pool, runOptions, execute), 2);
  assert.match(prompts[0]!, /## Schwerpunkt des Nutzers\nStabilität/);
  assert.match(prompts[0]!, /höchstens 2 Zeilen/);
  assert.match(prompts[0]!, /## Offene Ideen[^#]*Push-Meldungen für Bugs/);
  const [done] = find(/SET status = 'done'/);
  assert.deepEqual(done?.values, ['r1', 2, 3]);
  const [chat] = find(/INSERT INTO chat_messages/);
  assert.match(String(chat?.values[1]), /^Ich habe 2 neue Ideen in Ideation angelegt \(3 verworfen: /);
  assert.match(String(chat?.values[1]), /- Export als CSV\n- Suche über alle Projekte/);
  assert.equal(chat?.values[2], VISIONARY_AUTHOR);
  const progress = find(/UPDATE visionary_runs SET progress/).map((query) => query.values[1]);
  assert.deepEqual(progress, ['Der Visionär liest das Projekt …', 'Prüft Dubletten und legt Ideen an …']);
});

test('Visionär-Lauf: eine Idee ohne Chat-Antwort', async () => {
  const { pool, find } = runPool([], { id: 'r2', focus: null, replyInChat: false });
  const { prompts, execute } = fakeClaude(idea('Export als CSV'));
  assert.equal(await processVisionaryRun(pool, runOptions, execute), 1);
  assert.doesNotMatch(prompts[0]!, /Schwerpunkt/);
  assert.deepEqual(find(/SET status = 'done'/)[0]?.values, ['r2', 1, 0]);
  assert.equal(find(/INSERT INTO chat_messages/).length, 0);
});

test('Visionär-Lauf: ungültige Modellantwort legt nichts an und meldet die Verwerfungen', async () => {
  const { pool, find } = runPool();
  const { execute } = fakeClaude(['@@IDEA kein json', idea('Ohne Beleg', { reason: 'Wäre schön.' })].join('\n'));
  assert.equal(await processVisionaryRun(pool, runOptions, execute), 0);
  assert.deepEqual(find(/SET status = 'done'/)[0]?.values, ['r1', 0, 2]);
  assert.equal(find(/INSERT INTO ideation_items/).length, 0);
  assert.match(
    String(find(/INSERT INTO chat_messages/)[0]?.values[1]),
    /^Ich habe keine neuen Ideen angelegt \(2 verworfen/,
  );
});

test('Visionär-Lauf: Antwort ohne @@IDEA-Zeilen gilt als erledigt ohne Ideen', async () => {
  const { pool, find } = runPool([], { id: 'r3', focus: null, replyInChat: false });
  const { execute } = fakeClaude('Ich habe keine Ideen.');
  assert.equal(await processVisionaryRun(pool, runOptions, execute), 0);
  assert.deepEqual(find(/SET status = 'done'/)[0]?.values, ['r3', 0, 0]);
});

test('Visionär-Lauf: leere Antwort mit Fehler-Exit ist ein fehlgeschlagener Lauf', async () => {
  const { pool, find } = runPool();
  const { execute } = fakeClaude('', 1);
  assert.equal(await processVisionaryRun(pool, runOptions, execute), 0);
  const [failed] = find(/SET status = 'failed'/);
  assert.deepEqual(failed?.values, ['r1', 'Der Visionär hat keine Antwort geliefert.']);
  assert.equal(find(/SET status = 'done'/).length, 0);
  assert.match(
    String(find(/INSERT INTO chat_messages/)[0]?.values[1]),
    /^Der Lauf ist fehlgeschlagen: Der Visionär hat/,
  );
});

test('Visionär-Lauf: Fehlertext der CLI wird zum Fehler des Laufs (gekürzt)', async () => {
  const { pool, find } = runPool([], { id: 'r4', focus: null, replyInChat: false });
  const { execute } = fakeClaude(`Anfang ${'x'.repeat(700)} Rate limit erreicht`, 1);
  assert.equal(await processVisionaryRun(pool, runOptions, execute), 0);
  const message = String(find(/SET status = 'failed'/)[0]?.values[1]);
  assert.equal(message.length, 600);
  assert.match(message, /Rate limit erreicht$/);
});

test('Visionär-Lauf: Fehler-Exit mit gültigen Ideen legt sie trotzdem an', async () => {
  const { pool } = runPool([], { id: 'r5', focus: null, replyInChat: false });
  const { execute } = fakeClaude(idea('Export als CSV'), 1);
  assert.equal(await processVisionaryRun(pool, runOptions, execute), 1);
});

test('Visionär-Lauf: Datenbankfehler beim Anlegen macht den Lauf „failed“; Chat-Fehler nur protokolliert', async (t) => {
  const errors = t.mock.method(console, 'error', () => undefined);
  const { pool, find } = runPool([
    [/INSERT INTO ideation_items/, new Error('Platte voll')],
    [/INSERT INTO chat_messages/, new Error('Chat weg')],
  ]);
  const { execute } = fakeClaude(idea('Export als CSV'));
  assert.equal(await processVisionaryRun(pool, runOptions, execute), 0);
  assert.deepEqual(find(/SET status = 'failed'/)[0]?.values, ['r1', 'Platte voll']);
  assert.ok(
    errors.mock.calls.some((entry) => /Visionär-Antwort im Chat fehlgeschlagen/.test(String(entry.arguments[0]))),
  );
});

test('Visionär-Lauf: Abbruch über die Oberfläche beendet den Agent und legt nichts an', async (t) => {
  const kill = t.mock.method(process, 'kill', () => true);
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const { pool, find } = runPool([[/SELECT status FROM visionary_runs/, [{ status: 'cancelled' }]]]);
    const { execute } = fakeClaude(idea('Export als CSV'), 143, async () => {
      // Der Wächter fragt alle zwei Sekunden den Status ab; „cancelled“ bricht ab.
      mock.timers.tick(2_000);
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.equal(await processVisionaryRun(pool, runOptions, execute), 0);
    assert.deepEqual(kill.mock.calls[0]?.arguments, [-4242, 'SIGTERM']);
    assert.equal(find(/INSERT INTO ideation_items/).length, 0);
    assert.equal(find(/SET status = 'done'/).length, 0);
    const [requeued] = find(/SET status = 'requested', started_at = NULL/);
    assert.deepEqual(requeued?.values, ['r1']);
  } finally {
    mock.timers.reset();
  }
});

test('Visionär-Lauf: Statusabfrage „running“ bricht nicht ab, Fehler der Abfrage auch nicht', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    for (const status of [[{ status: 'running' }], new Error('kurz weg')] as Answer[]) {
      const { pool } = runPool([[/SELECT status FROM visionary_runs/, status]], {
        id: 'r6',
        focus: null,
        replyInChat: false,
      });
      const { execute } = fakeClaude(idea('Export als CSV'), 0, async () => {
        mock.timers.tick(2_000);
        await new Promise((resolve) => setImmediate(resolve));
      });
      assert.equal(await processVisionaryRun(pool, runOptions, execute), 1);
    }
  } finally {
    mock.timers.reset();
  }
});

test('Kontextpaket: README und docs/*.md werden nicht über symbolische Links gelesen', async () => {
  const cwd = tempDir('visionary-links-');
  const outside = tempDir('visionary-outside-');
  writeFileSync(join(outside, 'history'), 'GEHEIMER-VERLAUF');
  mkdirSync(join(outside, 'docs'));
  writeFileSync(join(outside, 'docs', 'fremd.md'), 'GEHEIMER-ORDNER');
  symlinkSync(join(outside, 'history'), join(cwd, 'README.md'));
  mkdirSync(join(cwd, 'docs'));
  writeFileSync(join(cwd, 'docs', 'echt.md'), 'Echte Doku');
  symlinkSync(join(outside, 'history'), join(cwd, 'docs', 'x.md'));
  const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
  const context = await loadVisionaryContext(pool, 'p', cwd);
  assert.deepEqual(context.docs, [{ path: 'docs/echt.md', text: 'Echte Doku' }]);
  // Auch ein verlinkter docs-Ordner wird nicht gelesen.
  rmSync(join(cwd, 'docs'), { recursive: true });
  symlinkSync(join(outside, 'docs'), join(cwd, 'docs'));
  assert.deepEqual((await loadVisionaryContext(pool, 'p', cwd)).docs, []);
});
