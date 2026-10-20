import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import { expandOrderCommands, planSummary, relatedTestFiles, SKIPPED_NOTE, testerPlan } from './order-tests.js';
import { runBuiltinAgent } from './runner-steps.js';
import type { WorkflowAgent } from './runner-types.js';

test('Testdateien zu geänderten Dateien: Tests selbst und Geschwister mit gleichem Grundnamen', () => {
  const files = new Set([
    'src/a.test.ts',
    'src/b.spec.ts',
    'src/b.test.ts',
    'app/x.component.spec.ts',
    'scripts/tool.test.mjs',
    'src/geaendert.test.ts',
  ]);
  const exists = (path: string): boolean => files.has(path);
  assert.deepEqual(
    relatedTestFiles(
      [
        'src/a.ts',
        'src/b.ts',
        'app/x.component.html',
        'app/x.component.css',
        'scripts/tool.mjs',
        'src/geaendert.test.ts',
        'src/geloescht.test.ts',
        'README.md',
        'src/ohne-test.ts',
      ],
      exists,
    ),
    [
      'app/x.component.spec.ts',
      'scripts/tool.test.mjs',
      'src/a.test.ts',
      'src/b.spec.ts',
      'src/b.test.ts',
      'src/geaendert.test.ts',
    ],
  );
  assert.deepEqual(relatedTestFiles([], exists), []);
});

test('Platzhalter: {tests} und {files} werden zu einzelnen Argumenten, leere Platzhalter überspringen den Befehl', () => {
  const commands = [
    ['npm', 'run', 'typecheck'],
    ['npx', 'tsx', '--test', '{tests}'],
    ['npx', 'eslint', '{files}'],
  ];
  assert.deepEqual(expandOrderCommands(commands, ['src/a.ts', 'src/a.test.ts'], ['src/a.test.ts']), [
    { command: ['npm', 'run', 'typecheck'], skipped: false },
    { command: ['npx', 'tsx', '--test', 'src/a.test.ts'], skipped: false },
    { command: ['npx', 'eslint', 'src/a.ts', 'src/a.test.ts'], skipped: false },
  ]);
  assert.deepEqual(expandOrderCommands(commands, ['README.md'], []), [
    { command: ['npm', 'run', 'typecheck'], skipped: false },
    { command: ['npx', 'tsx', '--test', '{tests}'], skipped: true },
    { command: ['npx', 'eslint', 'README.md'], skipped: false },
  ]);
});

function poolWith(orderCommands: unknown, testCommands: unknown = [['npm', 'run', 'test:full']]) {
  const steps: { position: number; command: string; status: string; output: string }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('order_test_commands')) return { rows: [{ commands: orderCommands }] };
      if (sql.includes('test_commands')) return { rows: [{ commands: testCommands }] };
      if (sql.includes('INSERT INTO test_runs')) return { rows: [{ id: values[0] }] };
      if (sql.includes('INSERT INTO test_run_steps')) {
        steps.push({ position: Number(values[1]), command: String(values[2]), status: 'running', output: '' });
      }
      if (sql.includes('UPDATE test_run_steps')) {
        const step = steps.find((entry) => entry.position === Number(values[1]));
        if (step) Object.assign(step, { status: values[2], output: values[5] });
      }
      if (sql.includes('FROM test_run_steps')) return { rows: steps };
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, steps };
}

test('Tester-Plan: ohne Testbefehle je Auftrag oder ohne bekannte Änderungen gelten die Testbefehle des Projekts', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'order-plan-'));
  const legacy = await testerPlan(poolWith(null).pool, 'p', cwd, ['src/a.ts']);
  assert.equal(legacy.scoped, false);
  assert.deepEqual(legacy.commands, [{ command: ['npm', 'run', 'test:full'], skipped: false }]);
  const unknown = await testerPlan(poolWith([['npx', 'tsx', '--test', '{tests}']]).pool, 'p', cwd, undefined);
  assert.equal(unknown.scoped, false);
  assert.equal(planSummary(unknown), '');
});

const tester: WorkflowAgent = {
  id: 'tester-id',
  name: 'Tester',
  role: 'tester',
  phase: 'while_task',
  position: 1,
  instructions: '',
  command: null,
};

test('eingebauter Tester: führt nur die Testbefehle je Auftrag zu den geänderten Dateien aus, nie den vollen Lauf', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'order-tester-'));
  await writeFile(join(cwd, 'a.ts'), 'export const a = 1;');
  await writeFile(join(cwd, 'a.test.ts'), '');
  const { pool, steps } = poolWith([
    ['node', '-e', 'process.exit(process.argv.at(-1) === "a.test.ts" ? 0 : 1)', '{tests}'],
    ['node', '-e', 'process.exit(0)', '{files}'],
  ]);
  const result = await runBuiltinAgent({
    pool,
    item: { id: 'item-1', projectSlug: 'p', title: 'T', description: '' },
    agent: tester,
    prompt: '',
    cwd,
    timeoutMs: 30_000,
    changedFiles: ['a.ts', 'weg.ts'],
  });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(steps.length, 2);
  assert.ok(!steps.some((step) => step.command.includes('test:full')));
  assert.match(steps[0]?.command ?? '', /a\.test\.ts$/);
  assert.match(steps[1]?.command ?? '', /process\.exit\(0\) a\.ts$/);
  assert.match(result.output, /Tests beschränkt auf die 1 geänderte\(n\) Datei\(en\)/);
});

test('eingebauter Tester: keine passenden Tests – Befehl übersprungen, Schritt bestanden mit Hinweis', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'order-skip-'));
  await writeFile(join(cwd, 'README.md'), '# Doku');
  const { pool, steps } = poolWith([['node', '-e', 'process.exit(1)', '{tests}']]);
  const result = await runBuiltinAgent({
    pool,
    item: { id: 'item-1', projectSlug: 'p', title: 'T', description: '' },
    agent: tester,
    prompt: '',
    cwd,
    timeoutMs: 30_000,
    changedFiles: ['README.md'],
  });
  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(
    steps.map((step) => [step.status, step.output]),
    [['passed', SKIPPED_NOTE]],
  );
  assert.match(result.output, /übersprungen – keine passenden Tests zu den geänderten Dateien/);
  assert.match(result.output, /Alle Testbefehle übersprungen/);
});

test('der Entwickler-Prompt verlangt die Liste aller geänderten Dateien', async () => {
  const { buildPrompt } = await import('./runner-prompts.js');
  const item = { id: 'i', projectSlug: 'p', title: 'T', description: '' };
  assert.match(buildPrompt({ ...tester, role: 'developer' }, item, []), /## Geänderte Dateien/);
  assert.doesNotMatch(buildPrompt(tester, item, []), /Geänderte Dateien melden/);
});
