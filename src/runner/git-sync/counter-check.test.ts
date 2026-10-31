import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import { type CommandExecutor, runCommand } from '../../core/command.js';
import { classifyTestFileRun } from './ci.js';
import {
  COUNTER_CHECK_PREFIX,
  counterCheckOrder,
  counterCheckReport,
  needsCounterCheck,
  runSprintCounterChecks,
} from './counter-check.js';
import { enterOrderBranch, finishOrderBranch } from './order-branch.js';
import { syncSprintToGit } from './sprint-sync.js';
import { buildPrompt } from '../runner-prompts.js';
import type { WorkflowAgent } from '../runner-types.js';

const NODE_RUNNER = [['node', '--test', '{tests}']];
const TSX_RUNNER = [[join(process.cwd(), 'node_modules', '.bin', 'tsx'), '--test', '{tests}']];
/** Ohne NODE_TEST_CONTEXT des äusseren Testlaufs: sonst meldete der innere Runner wie ein Kindprozess. */
const CLEAN_ENV = { PATH: process.env.PATH };
const SPRINT = { name: 'Sprint 9', branch: 'sprint/sprint-9' };
const ORDER = { id: 'bbbbbbbb-0000-4000-8000-000000000009', title: 'Addition rechnet falsch', kind: 'bug' };

const BASE_FILES: Record<string, string> = {
  'package.json': '{ "type": "module" }\n',
  'src/calc.mjs': 'export function add(a, b) {\n  return a - b;\n}\n',
  'src/calc.ts': 'export function add(a: number, b: number): number {\n  return a - b;\n}\n',
  'src/parse.ts': 'export function parse(text: string): number {\n  return Number(text) + ;\n}\n',
};

/** Der Fix: Produktivcode, neue Module und die Tests des Auftrags. */
const FIX_FILES: Record<string, string> = {
  'src/calc.mjs': 'export function add(a, b) {\n  return a + b;\n}\n',
  'src/helper.mjs': 'export const helper = () => 1;\n',
  'src/daten.txt': 'da\n',
  'src/calc.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
  'src/neu.ts': 'export const neu = (): number => 1;\n',
  'src/parse.ts': 'export function parse(text: string): number {\n  return Number(text);\n}\n',
  // node --test (.mjs)
  'src/calc.test.mjs':
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './calc.mjs';\n\ntest('addiert', () => {\n  assert.equal(add(1, 2), 3);\n});\n",
  'src/green.test.mjs':
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './calc.mjs';\n\ntest('ist eine Funktion', () => {\n  assert.equal(typeof add, 'function');\n});\n",
  'src/helper.test.mjs':
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { helper } from './helper.mjs';\n\ntest('helper', () => {\n  assert.equal(helper(), 1);\n});\n",
  // Fehlendes Modul und ENOENT erst innerhalb eines laufenden Testfalls: „scheitert ohne Fix“, kein Importfehler.
  'src/inner.test.mjs':
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('lädt den Helfer erst im Test', async () => {\n  const { helper } = await import('./helper.mjs');\n  assert.equal(helper(), 1);\n});\n",
  'src/enoent.test.mjs':
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\n\ntest('liest die Daten', () => {\n  assert.equal(readFileSync(new URL('./daten.txt', import.meta.url), 'utf8'), 'da\\n');\n});\n",
  'e2e/login.spec.ts': "import { test } from '@playwright/test';\n\ntest('login', async () => {});\n",
  // tsx --test (.ts)
  'src/calc-ts.test.ts':
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './calc.ts';\n\ntest('addiert', () => {\n  assert.equal(add(1, 2), 3);\n});\n",
  'src/green-ts.test.ts':
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('grün', () => {\n  assert.equal(1 + 1, 2);\n});\n",
  'src/neu.test.ts':
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { neu } from './neu.ts';\n\ntest('neu', () => {\n  assert.equal(neu(), 1);\n});\n",
  'src/parse.test.ts':
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { parse } from './parse.ts';\n\ntest('parst', () => {\n  assert.equal(parse('2'), 2);\n});\n",
};

const NODE_TESTS = [
  'src/calc.test.mjs',
  'src/green.test.mjs',
  'src/helper.test.mjs',
  'src/inner.test.mjs',
  'src/enoent.test.mjs',
];
const TSX_TESTS = ['src/calc-ts.test.ts', 'src/green-ts.test.ts', 'src/neu.test.ts', 'src/parse.test.ts'];

async function writeAll(cwd: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
}

/** Repository mit main, Sprint-Branch und einem gemergten Bugfix-Auftrag (Merge-Commit wie im Ablauf). */
async function bugfixRepository(): Promise<{
  cwd: string;
  commit: string;
  changed: string[];
  git: (...args: string[]) => string;
}> {
  const cwd = await mkdtemp(join(tmpdir(), 'gegenprobe-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  await writeAll(cwd, BASE_FILES);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const branch = await enterOrderBranch(cwd, ORDER, SPRINT);
  assert.equal(branch?.base, SPRINT.branch);
  await writeAll(cwd, FIX_FILES);
  const finished = await finishOrderBranch(cwd, ORDER, branch!, SPRINT.name, true);
  assert.equal(finished.merged, true, finished.message);
  assert.ok(finished.commit);
  return { cwd, commit: finished.commit, changed: Object.keys(FIX_FILES).sort(), git };
}

/** Zustand, den die Gegenprobe nie verändern darf: HEAD, Branch, Status des Hauptordners und Sprint-Branch. */
const snapshot = (git: (...args: string[]) => string) => ({
  head: git('rev-parse', 'HEAD'),
  branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  status: git('status', '--porcelain', '--untracked-files=all'),
  sprint: git('rev-parse', SPRINT.branch),
  main: git('rev-parse', 'main'),
});

const worktrees = (git: (...args: string[]) => string) =>
  git('worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '));

const host = async (): Promise<CommandExecutor> => runCommand;

test('Gegenprobe: drei Ergebnisse mit node --test, Fehler im Testfall bleibt „scheitert ohne Fix“', async () => {
  const { cwd, commit, changed, git } = await bugfixRepository();
  const before = snapshot(git);
  const check = await counterCheckOrder({
    cwd,
    commit,
    changedFiles: changed.filter((path) => !path.endsWith('.ts') || path.startsWith('e2e/')),
    commands: NODE_RUNNER,
    execute: runCommand,
    testExecutor: host,
  });
  assert.equal(check.error, undefined, check.error);
  assert.equal(check.base, git('rev-parse', `${commit}^1`), 'Basis ist der Stand vor dem Merge des Fixes');
  const results = Object.fromEntries(check.files.map((file) => [file.path, file.result]));
  assert.deepEqual(results, {
    'e2e/login.spec.ts': 'skipped',
    'src/calc.test.mjs': 'fails',
    'src/enoent.test.mjs': 'fails',
    'src/green.test.mjs': 'passes',
    'src/helper.test.mjs': 'import',
    'src/inner.test.mjs': 'fails',
  });
  assert.deepEqual(snapshot(git), before, 'Hauptordner und Sprint-Branch unverändert');
  assert.equal(worktrees(git).length, 1, 'Gegenprobe-Worktree entfernt');
  assert.equal(git('branch', '--list', 'auftrag/*'), '', 'kein Branch angelegt');

  // Gegenprobe der Gegenprobe: Mit dem Fix laufen dieselben Tests grün.
  for (const path of NODE_TESTS) {
    assert.equal((await runCommand(['node', '--test', path], cwd, { env: CLEAN_ENV })).exitCode, 0, path);
  }
});

test('Gegenprobe: drei Ergebnisse mit tsx --test (fehlendes Modul und Syntaxfehler = Import)', async () => {
  const { cwd, commit, changed, git } = await bugfixRepository();
  const before = snapshot(git);
  const check = await counterCheckOrder({
    cwd,
    commit,
    changedFiles: changed.filter((path) => path.startsWith('src/') && path.endsWith('.ts')),
    commands: TSX_RUNNER,
    execute: runCommand,
    testExecutor: host,
  });
  assert.equal(check.error, undefined, check.error);
  const results = Object.fromEntries(check.files.map((file) => [file.path, file.result]));
  assert.deepEqual(results, {
    'src/calc-ts.test.ts': 'fails',
    'src/green-ts.test.ts': 'passes',
    'src/neu.test.ts': 'import',
    'src/parse.test.ts': 'import',
  });
  assert.deepEqual(snapshot(git), before);
  assert.equal(worktrees(git).length, 1);
  for (const path of TSX_TESTS) {
    assert.equal((await runCommand([TSX_RUNNER[0]![0]!, '--test', path], cwd, { env: CLEAN_ENV })).exitCode, 0, path);
  }
});

test('Gegenprobe: Worktree weg nach fehlendem Befehl, Zeitüberschreitung und Fehler des Executors', async () => {
  const { cwd, commit, git } = await bugfixRepository();
  const before = snapshot(git);
  const base = { cwd, commit, changedFiles: ['src/calc.test.mjs'], execute: runCommand, testExecutor: host };

  const missing = await counterCheckOrder({ ...base, commands: [['gibt-es-nicht-gegenprobe', '{tests}']] });
  assert.equal(missing.files[0]?.result, 'error');
  assert.match(missing.files[0]?.detail ?? '', /nicht ausführbar/);
  assert.equal(worktrees(git).length, 1);

  const slow = await counterCheckOrder({
    ...base,
    commands: [[process.execPath, '-e', 'setTimeout(() => {}, 20000)', '{tests}']],
    commandTimeoutMs: 500,
  });
  assert.equal(slow.files[0]?.result, 'error');
  assert.match(slow.files[0]?.detail ?? '', /Zeitüberschreitung/);
  assert.equal(worktrees(git).length, 1);

  const broken = await counterCheckOrder({
    ...base,
    commands: NODE_RUNNER,
    testExecutor: async () => {
      throw new Error('Sandbox nicht bereit');
    },
  });
  assert.match(broken.error ?? '', /Sandbox nicht bereit/);
  assert.equal(worktrees(git).length, 1);

  // Ohne {tests}-Befehl: sichtbarer Fehler, kein Lauf der vollständigen Suite.
  const plain = await counterCheckOrder({ ...base, commands: [['npm', 'test']] });
  assert.match(plain.error ?? '', /\{tests\}/);
  assert.deepEqual(snapshot(git), before);
});

test('Gegenprobe: verwaister Worktree eines abgebrochenen Laufs wird beim Start entfernt', async () => {
  const { cwd, commit, git } = await bugfixRepository();
  const orphan = join(await mkdtemp(join(tmpdir(), 'gegenprobe-alt-')), `${COUNTER_CHECK_PREFIX}alt`);
  git('worktree', 'add', '--detach', orphan, 'main');
  assert.equal(worktrees(git).length, 2);
  const check = await counterCheckOrder({
    cwd,
    commit,
    changedFiles: ['src/calc.test.mjs'],
    commands: NODE_RUNNER,
    execute: runCommand,
    testExecutor: host,
  });
  assert.equal(check.files[0]?.result, 'fails');
  assert.equal(worktrees(git).length, 1);
  assert.equal(existsSync(orphan), false);
});

test('Gegenprobe nur für Bugfixes mit geänderter Testdatei', () => {
  assert.equal(needsCounterCheck({ kind: 'bug', changedFiles: ['src/a.ts', 'src/a.test.ts'] }), true);
  assert.equal(needsCounterCheck({ kind: 'feature', changedFiles: ['src/a.test.ts'] }), false);
  assert.equal(needsCounterCheck({ kind: 'bug', changedFiles: ['src/a.ts', 'README.md'] }), false);
  assert.equal(needsCounterCheck({ kind: 'bug', changedFiles: [] }), false);
});

/** Attrappe für Sprint-Abschluss und Gegenprobe: zeichnet alle Abfragen auf. */
function sprintPool(orders: { id: string; title: string; commit: string | null; changedFiles: string[] }[]) {
  const queries: { sql: string; values: unknown[] }[] = [];
  let claimed = false;
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes("SET git_sync = 'running'") && !claimed) {
        claimed = true;
        return {
          rows: [
            {
              id: 'abcdef12-0000-0000-0000-000000000000',
              ...SPRINT,
              action: 'push',
              remote: null,
              status: 'completed',
              hasDone: true,
            },
          ],
        };
      }
      if (sql.includes('order_test_commands')) return { rows: [{ commands: NODE_RUNNER }] };
      if (sql.includes('test_commands')) return { rows: [{ commands: [['true']] }] };
      if (sql.includes('counter_check IS NULL')) return { rows: orders };
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, queries };
}

test('Sprint-Abschluss: rote Gegenprobe verhindert weder Merge noch „done“, Ergebnis am Auftrag und im Bericht', async () => {
  const { cwd, commit, git } = await bugfixRepository();
  const { pool, queries } = sprintPool([
    { id: ORDER.id, title: ORDER.title, commit, changedFiles: ['src/calc.mjs', 'src/calc.test.mjs'] },
  ]);
  assert.equal(await syncSprintToGit(pool, 'p', cwd), 1);
  const final = queries.at(-1);
  assert.match(final?.sql ?? '', /git_sync = 'done'/);
  assert.match(String(final?.values[1]), /Gegenprobe \(1 Testdatei\): 1 scheitern ohne Fix/);
  assert.equal(git('show', 'main:src/calc.mjs'), FIX_FILES['src/calc.mjs']!.trim(), 'Fix ist in main');
  assert.equal(worktrees(git).length, 1);

  const stored = queries.find((query) => query.sql.includes('SET counter_check'));
  assert.equal(stored?.values[0], ORDER.id);
  const check = JSON.parse(String(stored?.values[1])) as { files: { path: string; result: string }[] };
  assert.deepEqual(
    check.files.map((file) => [file.path, file.result]),
    [['src/calc.test.mjs', 'fails']],
  );
  const report = String(queries.find((query) => query.sql.includes('SET report'))?.values[1]);
  assert.equal(report.split('\n').filter((line) => line.includes('src/calc.test.mjs')).length, 1);
  assert.match(report, /`src\/calc\.test\.mjs` \(„Addition rechnet falsch“\): \*\*scheitert ohne Fix\*\*/);
  assert.ok(queries.some((query) => /INSERT INTO test_runs/.test(query.sql) && query.values[2] === 'counter-check'));
});

test('Gegenprobe: ohne passenden Auftrag keine Abfrage der Befehle, kein Testlauf, kein Ergebnis', async () => {
  const { pool, queries } = sprintPool([
    { id: ORDER.id, title: 'ohne Tests', commit: 'abc', changedFiles: ['a.ts', 'README.md'] },
  ]);
  const line = await runSprintCounterChecks({
    pool,
    project: 'p',
    sprint: { id: 's', name: 'S' },
    cwd: tmpdir(),
    execute: runCommand,
    testExecutor: host,
    linkModules: false,
  });
  assert.equal(line, null);
  const select = queries[0]?.sql ?? '';
  assert.match(select, /kind = 'bug'/);
  assert.match(select, /counter_check IS NULL/);
  assert.ok(!queries.some((query) => /test_runs|SET counter_check/.test(query.sql)));
});

test('Gegenprobe ohne Auftrags-Commit: Fehler sichtbar am Auftrag und im Bericht', async () => {
  const { pool, queries } = sprintPool([
    { id: ORDER.id, title: 'Review-Auftrag', commit: null, changedFiles: ['src/a.test.ts'] },
  ]);
  const line = await runSprintCounterChecks({
    pool,
    project: 'p',
    sprint: { id: 's', name: 'S' },
    cwd: tmpdir(),
    execute: runCommand,
    testExecutor: host,
    linkModules: false,
  });
  assert.match(line ?? '', /1 nicht prüfbar/);
  const stored = JSON.parse(String(queries.find((query) => query.sql.includes('SET counter_check'))?.values[1]));
  assert.match(stored.error, /Kein Auftrags-Commit/);
  const report = String(queries.find((query) => query.sql.includes('SET report'))?.values[1]);
  assert.match(report, /Review-Auftrag.*Gegenprobe gescheitert.*Kein Auftrags-Commit/);
});

test('Dokumentierer-Prompt: Gegenprobe beim Bugfix nicht als offen vermerken', () => {
  const documenter: WorkflowAgent = {
    id: 'doc',
    name: 'Dokumentierer',
    role: 'documenter',
    phase: 'after_task',
    position: 1,
    instructions: '',
    command: null,
  };
  const item = { id: 'i', projectSlug: 'p', title: 'T', description: '' };
  assert.match(buildPrompt(documenter, { ...item, kind: 'bug' }, []), /Gegenprobe deshalb nicht als offen/);
  assert.doesNotMatch(buildPrompt(documenter, { ...item, kind: 'feature' }, []), /## Gegenprobe/);
  assert.doesNotMatch(buildPrompt({ ...documenter, role: 'developer' }, { ...item, kind: 'bug' }, []), /## Gegenprobe/);
});

test('Bericht: genau eine Zeile je Testdatei, Hinweis bei „läuft auch ohne Fix grün“', () => {
  const report = counterCheckReport('S', [
    {
      title: 'Fix',
      check: {
        checkedAt: '',
        base: null,
        commit: null,
        files: [
          { path: 'a.test.ts', result: 'fails', detail: 'Rot' },
          { path: 'b.test.ts', result: 'passes' },
          { path: 'c.test.ts', result: 'import', detail: 'Cannot find module' },
        ],
      },
    },
  ]);
  for (const path of ['a.test.ts', 'b.test.ts', 'c.test.ts']) {
    assert.equal(report.split('\n').filter((line) => line.includes(path)).length, 1, path);
  }
  assert.match(report, /b\.test\.ts.*läuft auch ohne Fix grün.*beweist den Fix nicht/);
  assert.match(report, /c\.test\.ts.*bricht beim Import ab/);
});

test('Klassifikation: Ladefehler nur vor dem ersten Testfall (node:test, Vitest, Jest)', () => {
  const file = 'src/x.test.ts';
  // node:test (TAP): Ladefehler als Fehlschlag der Datei selbst.
  assert.equal(
    classifyTestFileRun(
      1,
      "TAP version 13\n# Subtest: /tmp/w/src/x.test.ts\nnot ok 1 - /tmp/w/src/x.test.ts\n  ---\n  error: 'test failed'\n  stderr: Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/w/src/neu.js'\n# pass 0\n# fail 1\n",
      file,
    ),
    'load-error',
  );
  // node:test (Spec): fehlendes Modul innerhalb eines Testfalls.
  assert.equal(
    classifyTestFileRun(
      1,
      "✖ lädt den Helfer (2.1ms)\n  Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/w/src/helper.mjs'\nℹ tests 1\nℹ fail 1\n",
      file,
    ),
    'failed',
  );
  // ENOENT ist nie ein Ladefehler.
  assert.equal(
    classifyTestFileRun(1, "Error: ENOENT: no such file or directory, open '/tmp/w/daten.txt'\n", file),
    'failed',
  );
  // Vitest: Datei lädt nicht bzw. Testfall rot mit SyntaxError aus JSON.parse.
  assert.equal(
    classifyTestFileRun(
      1,
      ' FAIL  src/x.test.ts [ src/x.test.ts ]\nError: Failed to load url ./neu (resolved id: ./neu) in src/x.test.ts\n Test Files  1 failed (1)\n      Tests  no tests\n',
      file,
    ),
    'load-error',
  );
  assert.equal(
    classifyTestFileRun(
      1,
      ' ❯ src/x.test.ts (1 test | 1 failed) 4ms\n   × parst JSON 3ms\n FAIL  src/x.test.ts > parst JSON\nSyntaxError: Unexpected token } in JSON\n',
      file,
    ),
    'failed',
  );
  // Jest: Suite lädt nicht bzw. Testfall rot.
  assert.equal(
    classifyTestFileRun(
      1,
      " FAIL  src/x.test.ts\n  ● Test suite failed to run\n\n    Cannot find module './neu' from 'src/x.test.ts'\n",
      file,
    ),
    'load-error',
  );
  assert.equal(
    classifyTestFileRun(
      1,
      ' FAIL  src/x.test.ts\n  ✕ addiert (3 ms)\n  ● addiert\n    expect(received).toBe(expected)\n',
      file,
    ),
    'failed',
  );
  assert.equal(classifyTestFileRun(0, 'SyntaxError im Log, aber grün', file), 'passed');
});
