import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import { type CommandExecutor, runCommand } from '../core/command.js';
import {
  caseStatuses,
  classifyCases,
  COUNTER_PROBE_PREFIX,
  counterProbeSection,
  newTestCases,
  probeVerdict,
  pruneStaleProbes,
  runCounterProbe,
  testCaseNames,
  withNameFilter,
  withProbeSection,
  writeProbeReport,
} from './counter-probe.js';
import { enterOrderBranch } from './git-sync/order-branch.js';
import { runWorkItem, type BuiltinAgent, type WorkflowAgent } from './runner.js';

const NODE_RUNNER = [['node', '--test', '{tests}']];
const ORDER = { id: 'cccccccc-0000-4000-8000-000000000001', title: 'Addition rechnet falsch' };

// --- Diff-Erkennung ---

test('Gegenprobe-Auftrag: Testfall-Namen aus test()/it(), ohne skip, t.test, Template mit ${} und Fixture-Text', () => {
  const source = [
    "import test, { describe, it } from 'node:test';",
    "test('addiert', () => {});",
    'test("mit \\"Zitat\\"", async () => {});',
    "describe('Gruppe', () => { it('innen', () => {}); });",
    "test.only('nur dieser', () => {});",
    "test.skip('übersprungen', () => {});",
    "test('eltern', async (t) => { await t.test('kind', () => {}); });",
    'test(`fest`, () => {});',
    'test(`mit ${wert}`, () => {});',
    "const fixture = \"import test from 'node:test';\\ntest('nur Text', () => {});\";",
    "test('addiert', () => {});",
  ].join('\n');
  assert.deepEqual(testCaseNames(source), ['addiert', 'mit "Zitat"', 'innen', 'nur dieser', 'eltern', 'fest']);
});

test('Gegenprobe-Auftrag: neue Testfälle = Namen, die es auf dem alten Stand nicht gab; neue Datei = alle', () => {
  const before = "test('alt', () => {});\ntest('geändert', () => { /* alt */ });\n";
  const after = "test('alt', () => {});\ntest('geändert', () => { /* neu */ });\nit('neu', () => {});\n";
  assert.deepEqual(newTestCases(before, after), ['neu']);
  assert.deepEqual(newTestCases(null, after), ['alt', 'geändert', 'neu']);
  assert.deepEqual(newTestCases(after, after), []);
});

test('Gegenprobe-Auftrag: Namensfilter steht vor {tests} und trifft nur genau die Namen (auch in describe)', () => {
  const [command] = NODE_RUNNER;
  assert.ok(command);
  const filtered = withNameFilter(command, ['a (b)', 'c']);
  assert.deepEqual(filtered.slice(0, 2), ['node', '--test']);
  assert.equal(filtered[3], '{tests}');
  const pattern = new RegExp(String(filtered[2]).slice('--test-name-pattern='.length));
  assert.ok(pattern.test('a (b)'));
  assert.ok(pattern.test('Gruppe c'), 'voller Name in describe');
  assert.ok(!pattern.test('ab'));
  assert.ok(!pattern.test('c d'));
  assert.ok(!pattern.test('xc'));
});

// --- Ergebnisklassifikation ---

test('Gegenprobe-Auftrag: Ergebnis je Testfall aus TAP und Spec-Ausgabe, Fehlschlag überwiegt', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: Gruppe',
    '    ok 1 - innen',
    '    not ok 2 - rot',
    'not ok 1 - Gruppe',
    'ok 2 - grün # SKIP',
    'ok 3 - mit \\# Raute',
  ].join('\n');
  assert.deepEqual(
    [...caseStatuses(tap)],
    [
      ['innen', 'passed'],
      ['rot', 'failed'],
      ['Gruppe', 'failed'],
      ['grün', 'skipped'],
      ['mit # Raute', 'passed'],
    ],
  );
  const spec =
    '▶ Gruppe\n  ✔ innen (0.4ms)\n  ✖ rot (1.2ms)\n✖ failing tests:\n\n✖ rot (1.2ms)\n﹣ weg (0.1ms) # SKIP\n';
  const statuses = caseStatuses(spec);
  assert.equal(statuses.get('innen'), 'passed');
  assert.equal(statuses.get('rot'), 'failed');
  assert.equal(statuses.get('weg'), 'skipped');
});

test('Gegenprobe-Auftrag: Import- oder Ladefehler und nicht gelaufene Befehle sind nie „scheitert wie erwartet“', () => {
  const importError = classifyCases('src/a.test.ts', ['x', 'y'], {
    exitCode: 1,
    output: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/w/src/neu.ts'\n✖ src/a.test.ts (20ms)\n",
    problem: null,
  });
  assert.deepEqual(
    importError.map((entry) => entry.result),
    ['inconclusive', 'inconclusive'],
  );
  assert.match(importError[0]?.detail ?? '', /Cannot find module/);
  const compile = classifyCases('src/a.test.ts', ['x'], {
    exitCode: 1,
    output: "SyntaxError: The requested module './calc.ts' does not provide an export named 'neu'\n",
    problem: null,
  });
  assert.equal(compile[0]?.result, 'inconclusive');
  const timeout = classifyCases('src/a.test.ts', ['x'], { exitCode: 1, output: '', problem: 'Zeitüberschreitung.' });
  assert.deepEqual(timeout, [
    { file: 'src/a.test.ts', name: 'x', result: 'inconclusive', detail: 'Zeitüberschreitung.' },
  ]);
  const run = classifyCases('src/a.test.ts', ['rot', 'grün', 'fehlt'], {
    exitCode: 1,
    output: 'not ok 1 - rot\nok 2 - grün\n',
    problem: null,
  });
  assert.deepEqual(
    run.map((entry) => entry.result),
    ['fails', 'passes', 'inconclusive'],
  );
});

test('Gegenprobe-Auftrag: Urteil – ein bestandener Fall reicht für „unproven“, nicht auswertbar ist kein Beleg', () => {
  const entry = (result: 'fails' | 'passes' | 'inconclusive') => ({ file: 'f', name: result, result });
  assert.equal(probeVerdict([]), 'none');
  assert.equal(probeVerdict([entry('fails'), entry('fails')]), 'proven');
  assert.equal(probeVerdict([entry('fails'), entry('inconclusive')]), 'inconclusive');
  assert.equal(probeVerdict([entry('inconclusive'), entry('passes')]), 'unproven');
});

// --- Bericht ---

test('Gegenprobe-Auftrag: Abschnitt „Gegenprobe“ mit Name und Ergebnis je Testfall bzw. dem Grund ohne Lauf', () => {
  const section = counterProbeSection({
    checkedAt: '',
    base: 'abcdef1234',
    commit: null,
    files: [],
    cases: [
      { file: 'src/a.test.ts', name: 'a | b', result: 'passes' },
      { file: 'src/a.test.ts', name: 'c', result: 'inconclusive', detail: 'Importfehler' },
    ],
    verdict: 'unproven',
  });
  assert.match(section, /^## Gegenprobe\n/);
  assert.match(section, /`abcdef1`/);
  assert.match(section, /\| a \\\| b \| `src\/a\.test\.ts` \| \*\*besteht \(Fix nicht belegt\)\*\* \|/);
  assert.match(section, /\| c \| `src\/a\.test\.ts` \| \*\*nicht auswertbar\*\* – Importfehler \|/);
  assert.match(section, /\*\*Test belegt den Fix nicht:\*\*/);
  const none = counterProbeSection({
    checkedAt: '',
    base: null,
    commit: null,
    files: [],
    verdict: 'none',
    reason: 'Keine neuen Testfälle.',
  });
  assert.equal(none, '## Gegenprobe\n\nKeine neuen Testfälle.\n');
});

test('Gegenprobe-Auftrag: Abschnitt ersetzt einen vorhandenen und lässt die übrigen stehen', () => {
  const report = '# Bericht\n\n## Tests\nalles grün\n\n## Gegenprobe\nalt\n\n## Ende\nfertig\n';
  const updated = withProbeSection(report, '## Gegenprobe\n\nneu\n');
  assert.equal(updated, '# Bericht\n\n## Tests\nalles grün\n\n## Gegenprobe\n\nneu\n\n## Ende\nfertig\n');
  assert.equal(withProbeSection('# Bericht\n', '## Gegenprobe\n\nx\n'), '# Bericht\n\n## Gegenprobe\n\nx\n');
});

test('Gegenprobe-Auftrag: Bericht landet im jüngsten bericht.md des Schritts, sonst in einem eigenen Lauf-Ordner', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'gegenprobe-bericht-'));
  const old = join(cwd, 'docs', 'tests', '2026-01-01_10-00', 'bericht.md');
  await mkdir(dirname(old), { recursive: true });
  await writeFile(old, '# Alt\n');
  await utimes(old, new Date('2026-01-01'), new Date('2026-01-01'));
  const since = Date.now() - 1000;
  const created = await writeProbeReport(cwd, '## Gegenprobe\n\nx\n', since, new Date(2026, 9, 31, 9, 5));
  assert.equal(created, join('docs', 'tests', '2026-10-31_09-05_gegenprobe', 'bericht.md'));
  assert.equal(await readFile(join(cwd, created), 'utf8'), '# Testbericht: Gegenprobe\n\n## Gegenprobe\n\nx\n');
  assert.equal(await readFile(old, 'utf8'), '# Alt\n', 'älterer Bericht bleibt unberührt');

  const fresh = join(cwd, 'docs', 'tests', '2026-10-31_09-10', 'bericht.md');
  await mkdir(dirname(fresh), { recursive: true });
  await writeFile(fresh, '# Testbericht\n\n## Ergebnis\ngrün\n');
  const target = await writeProbeReport(cwd, '## Gegenprobe\n\ny\n', since);
  assert.equal(target, join('docs', 'tests', '2026-10-31_09-10', 'bericht.md'));
  assert.equal(await readFile(fresh, 'utf8'), '# Testbericht\n\n## Ergebnis\ngrün\n\n## Gegenprobe\n\ny\n');
});

// --- Ablauf mit echtem Git-Repo ---

const BASE_FILES: Record<string, string> = {
  'package.json': '{ "type": "module" }\n',
  'src/calc.mjs': 'export function add(a, b) {\n  return a - b;\n}\n',
  'src/calc.test.mjs':
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './calc.mjs';\n\ntest('ist eine Funktion', () => {\n  assert.equal(typeof add, 'function');\n});\n",
};

const FIXED_CALC = 'export function add(a, b) {\n  return a + b;\n}\n';
/** Bestehende Testdatei mit neuem Fall, der den Fehler zeigt (der alte Fall läuft auf dem alten Stand grün). */
const CALC_TEST_WITH_CASE = `${BASE_FILES['src/calc.test.mjs']}\ntest('addiert richtig', () => {\n  assert.equal(add(1, 2), 3);\n});\n`;
/** Neue Datei, im Arbeitsordner noch nicht committet (Tester), mit describe. */
const EXTRA_TEST =
  "import { describe, it } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './calc.mjs';\n\ndescribe('Gruppe', () => {\n  it('zwei plus zwei', () => {\n    assert.equal(add(2, 2), 4);\n  });\n});\n";
/** Testfall, der den Fehler nicht berührt: besteht auch ohne Fix. */
const WEAK_TEST =
  "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './calc.mjs';\n\ntest('liefert eine Zahl', () => {\n  assert.equal(typeof add(1, 2), 'number');\n});\n";
const IMPORT_TEST =
  "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { helper } from './helper.mjs';\n\ntest('Helfer', () => {\n  assert.equal(helper(), 1);\n});\n";

async function writeAll(cwd: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
}

/** Repository auf main mit dem fehlerhaften Stand; der Auftrag steht auf seinem Branch (ohne Sprint, Basis main). */
async function orderRepository(): Promise<{ cwd: string; git: (...args: string[]) => string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'gegenprobe-auftrag-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  await writeAll(cwd, BASE_FILES);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const branch = await enterOrderBranch(cwd, ORDER, null);
  assert.equal(branch?.base, 'main');
  return { cwd, git };
}

/** Zwei Commits des Auftrags (wie je Agent), damit die Basis nicht „Vorgänger des letzten Commits“ sein kann. */
function commitOrder(git: (...args: string[]) => string, message: string): void {
  git('add', '-A');
  git('commit', '-q', '-m', message, '-m', `Auftrag: ${ORDER.id}`);
}

const snapshot = async (cwd: string, git: (...args: string[]) => string, files: string[]) => ({
  head: git('rev-parse', 'HEAD'),
  branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  status: git('status', '--porcelain', '--untracked-files=all'),
  main: git('rev-parse', 'main'),
  files: await Promise.all(files.map((file) => readFile(join(cwd, file), 'utf8'))),
});

const worktrees = (git: (...args: string[]) => string) =>
  git('worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '));

const probeFolders = async () =>
  (await readdir(tmpdir())).filter((name) => name.startsWith(COUNTER_PROBE_PREFIX)).map((name) => join(tmpdir(), name));

const host = async (): Promise<CommandExecutor> => runCommand;

test('Gegenprobe-Auftrag: Fix belegt – alle neuen Fälle scheitern auf dem alten Stand, Ordner bleibt unberührt', async () => {
  const { cwd, git } = await orderRepository();
  await writeAll(cwd, { 'src/calc.mjs': FIXED_CALC });
  commitOrder(git, 'Entwickler: Fix');
  await writeAll(cwd, { 'src/calc.test.mjs': CALC_TEST_WITH_CASE });
  commitOrder(git, 'Tester: Test');
  await writeAll(cwd, { 'src/extra.test.mjs': EXTRA_TEST });
  const before = await snapshot(cwd, git, ['src/calc.mjs', 'src/extra.test.mjs']);
  const foldersBefore = await probeFolders();

  const check = await runCounterProbe({
    cwd,
    baseBranch: 'main',
    changedFiles: ['src/calc.mjs', 'src/calc.test.mjs', 'src/extra.test.mjs'],
    commands: NODE_RUNNER,
    execute: runCommand,
    testExecutor: host,
  });
  assert.equal(check.error, undefined, check.error);
  assert.equal(check.base, git('rev-parse', 'main'), 'Basis = merge-base mit main, vor dem ersten Auftrags-Commit');
  assert.deepEqual(
    check.cases?.map(({ file, name, result }) => ({ file, name, result })),
    [
      { file: 'src/calc.test.mjs', name: 'addiert richtig', result: 'fails' },
      { file: 'src/extra.test.mjs', name: 'zwei plus zwei', result: 'fails' },
    ],
    'nur neue Fälle; „ist eine Funktion“ (alt, auf dem alten Stand grün) läuft nicht mit',
  );
  assert.equal(check.verdict, 'proven');
  assert.deepEqual(await snapshot(cwd, git, ['src/calc.mjs', 'src/extra.test.mjs']), before);
  assert.equal(worktrees(git).length, 1, 'Gegenprobe-Worktree entfernt');
  assert.deepEqual(await probeFolders(), foldersBefore, 'Temp-Ordner entfernt');

  // Gegenprobe der Gegenprobe: Mit dem Fix laufen dieselben Tests grün.
  for (const path of ['src/calc.test.mjs', 'src/extra.test.mjs']) {
    assert.equal((await runCommand(['node', '--test', path], cwd, { env: { PATH: process.env.PATH } })).exitCode, 0);
  }
});

test('Gegenprobe-Auftrag (Fixture ohne Fix): ein Test, der auch ohne Fix besteht, meldet „Test belegt den Fix nicht“', async () => {
  const { cwd, git } = await orderRepository();
  // Absichtlich nicht gefixt: calc.mjs bleibt falsch, der neue Test prüft am Fehler vorbei.
  await writeAll(cwd, {
    'src/weak.test.mjs': WEAK_TEST,
    'src/helper.test.mjs': IMPORT_TEST,
    'src/helper.mjs': 'export const helper = () => 1;\n',
  });
  commitOrder(git, 'Entwickler: vermeintlicher Fix');
  const check = await runCounterProbe({
    cwd,
    baseBranch: 'main',
    changedFiles: ['src/helper.mjs', 'src/helper.test.mjs', 'src/weak.test.mjs'],
    commands: NODE_RUNNER,
    execute: runCommand,
    testExecutor: host,
  });
  const results = Object.fromEntries(check.cases?.map((entry) => [entry.name, entry.result]) ?? []);
  assert.deepEqual(results, { Helfer: 'inconclusive', 'liefert eine Zahl': 'passes' });
  assert.equal(check.verdict, 'unproven');
  assert.match(counterProbeSection(check), /Test belegt den Fix nicht/);
  assert.equal(worktrees(git).length, 1);
});

test('Gegenprobe-Auftrag: nur ein Importfehler ergibt „nicht auswertbar“, kein Beleg und keine Rückgabe', async () => {
  const { cwd, git } = await orderRepository();
  await writeAll(cwd, { 'src/helper.test.mjs': IMPORT_TEST, 'src/helper.mjs': 'export const helper = () => 1;\n' });
  commitOrder(git, 'Entwickler: Helfer');
  const check = await runCounterProbe({
    cwd,
    baseBranch: 'main',
    changedFiles: ['src/helper.mjs', 'src/helper.test.mjs'],
    commands: NODE_RUNNER,
    execute: runCommand,
    testExecutor: host,
  });
  assert.equal(check.cases?.[0]?.result, 'inconclusive');
  assert.match(check.cases?.[0]?.detail ?? '', /Cannot find module|ERR_MODULE_NOT_FOUND/);
  assert.equal(check.verdict, 'inconclusive');
});

test('Gegenprobe-Auftrag: ohne neue Testfälle kein Lauf (kein Worktree), Bericht nennt den Grund', async () => {
  const { cwd, git } = await orderRepository();
  await writeAll(cwd, {
    'src/calc.mjs': FIXED_CALC,
    'src/calc.test.mjs': `${BASE_FILES['src/calc.test.mjs']}// nur Kommentar\n`,
  });
  commitOrder(git, 'Entwickler: Fix ohne neuen Test');
  let started = false;
  const check = await runCounterProbe({
    cwd,
    baseBranch: 'main',
    changedFiles: ['src/calc.mjs', 'src/calc.test.mjs'],
    commands: NODE_RUNNER,
    execute: async (command, directory, options) => {
      if (command.includes('worktree') && command.includes('add')) started = true;
      return runCommand(command, directory, options);
    },
    testExecutor: host,
  });
  assert.equal(started, false);
  assert.equal(check.verdict, 'none');
  assert.match(counterProbeSection(check), /Keine neuen Testfälle/);
});

test('Gegenprobe-Auftrag: Worktree wird auch bei Fehler und Zeitüberschreitung entfernt', async () => {
  const { cwd, git } = await orderRepository();
  const hanging =
    "import test from 'node:test';\n\ntest('hängt', async () => {\n  await new Promise((resolve) => setTimeout(resolve, 60_000));\n});\n";
  await writeAll(cwd, { 'src/calc.mjs': FIXED_CALC, 'src/hang.test.mjs': hanging });
  commitOrder(git, 'Entwickler: Fix');
  const foldersBefore = await probeFolders();
  const options = {
    cwd,
    baseBranch: 'main',
    changedFiles: ['src/hang.test.mjs'],
    commands: NODE_RUNNER,
    execute: runCommand,
  };

  const failed = await runCounterProbe({
    ...options,
    testExecutor: async () => {
      throw new Error('Sandbox weg');
    },
  });
  assert.match(failed.error ?? '', /Sandbox weg/);
  assert.notEqual(failed.verdict, 'unproven');
  assert.equal(worktrees(git).length, 1, 'nach Fehler entfernt');

  const timedOut = await runCounterProbe({ ...options, testExecutor: host, commandTimeoutMs: 1500 });
  assert.equal(timedOut.cases?.[0]?.result, 'inconclusive');
  assert.equal(timedOut.verdict, 'inconclusive');
  assert.equal(worktrees(git).length, 1, 'nach Zeitüberschreitung entfernt');
  assert.deepEqual(await probeFolders(), foldersBefore);
});

test('Gegenprobe-Auftrag: verwaiste Worktrees (älter als zwei Stunden) werden beim nächsten Lauf entfernt', async () => {
  const { git, cwd } = await orderRepository();
  const stale = await mkdtemp(join(tmpdir(), COUNTER_PROBE_PREFIX));
  const fresh = await mkdtemp(join(tmpdir(), COUNTER_PROBE_PREFIX));
  await Promise.all([rm(stale, { recursive: true }), rm(fresh, { recursive: true })]);
  git('worktree', 'add', '--detach', stale, 'main');
  git('worktree', 'add', '--detach', fresh, 'main');
  await utimes(stale, new Date(Date.now() - 3 * 60 * 60_000), new Date(Date.now() - 3 * 60 * 60_000));
  await pruneStaleProbes(cwd, runCommand);
  const listed = worktrees(git).map((line) => basename(line.slice('worktree '.length)));
  assert.ok(!listed.includes(basename(stale)), 'verwaister entfernt');
  assert.ok(listed.includes(basename(fresh)), 'laufender bleibt');
  assert.equal(existsSync(stale), false);
  git('worktree', 'remove', '--force', fresh);
});

// --- Einbindung in den Tester-Schritt ---

const developer: WorkflowAgent = {
  id: 'dev-id',
  name: 'Entwickler',
  role: 'developer',
  phase: 'while_task',
  position: 1,
  instructions: 'Fix',
  command: ['dev'],
};
const tester: WorkflowAgent = {
  id: 'tester-id',
  name: 'Tester',
  role: 'tester',
  phase: 'while_task',
  position: 2,
  instructions: 'Testen',
  command: null,
};

function probePool() {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('INSERT INTO agent_runs')) return { rows: [{ id: 'run-1' }] };
      if (sql.includes('order_test_commands AS commands')) return { rows: [{ commands: NODE_RUNNER }] };
      return { rows: [{ id: 'step-row' }] };
    },
  } as unknown as Pool;
  return { pool, queries };
}

async function runOrder(kind: string) {
  const { cwd } = await orderRepository();
  const { pool, queries } = probePool();
  const calls: string[] = [];
  const execute: CommandExecutor = async (command, directory, options) => {
    if (command[0] !== 'dev') return runCommand(command, directory, options);
    calls.push('dev');
    await writeAll(cwd, { 'src/weak.test.mjs': WEAK_TEST });
    return { exitCode: 0, durationMs: 1, output: 'Fertig.' };
  };
  const builtin: BuiltinAgent = async () => ({ exitCode: 0, durationMs: 1, output: 'Tests grün' });
  const order = { ...ORDER, projectSlug: 'mainty', description: 'Addition', kind };
  const result = await runWorkItem(pool, order, [developer, tester], { cwd, timeoutMs: 60_000, execute, builtin });
  return { result, calls, queries };
}

test('Gegenprobe-Auftrag: Bugfix mit unbelegtem Test geht an den Entwickler zurück und wird markiert', async () => {
  const { result, calls, queries } = await runOrder('bug');
  assert.equal(result, 'failed');
  assert.deepEqual(calls, ['dev', 'dev'], 'einmal zur Nachbesserung zurück, danach Ende (keine Endlosschleife)');
  const saved = queries.filter((query) => query.sql.includes('SET counter_check'));
  assert.equal(saved.length, 2, 'je Tester-Schritt neu gespeichert');
  assert.equal(JSON.parse(String(saved[0]?.values[1])).verdict, 'unproven');
  const testerStep = queries.find(
    (query) =>
      query.sql.includes('UPDATE agent_run_steps SET status') && String(query.values[4]).startsWith('Tests grün'),
  );
  assert.equal(testerStep?.values[1], 'failed');
  assert.match(String(testerStep?.values[4]), /## Gegenprobe[\s\S]*liefert eine Zahl[\s\S]*Test belegt den Fix nicht/);
  const events = queries.filter((query) => query.sql.includes('SET events')).map((query) => String(query.values[1]));
  assert.ok(
    events.some((text) => /Gegenprobe: .*Test belegt den Fix nicht \(docs\/tests\/[^)]+\/bericht\.md\)/.test(text)),
    'Abschnitt im Testbericht docs/tests/<Lauf>/bericht.md',
  );
});

test('Gegenprobe-Auftrag: Aufträge, die kein Bugfix sind, werden nicht gegengeprüft', async () => {
  const { result, calls, queries } = await runOrder('feature');
  assert.equal(result, 'passed');
  assert.deepEqual(calls, ['dev']);
  assert.ok(!queries.some((query) => query.sql.includes('SET counter_check')));
});
