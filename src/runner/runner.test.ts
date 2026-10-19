import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import type { CommandExecutor } from '../core/command.js';
import {
  type BuiltinAgent,
  buildInvocation,
  buildPrompt,
  parseRunnerOptions,
  runWorkItem,
  type WorkflowAgent,
} from './runner.js';

const item = { id: 'item-1', projectSlug: 'mainty', title: 'Sprints', description: 'Bauen' };
const agent = (name: string, phase: string, position: number, command: string[] | null): WorkflowAgent => ({
  id: `${name}-id`,
  name,
  role: 'custom',
  phase,
  position,
  instructions: `${name} macht etwas`,
  command,
});

function fakePool(claimed = true) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('INSERT INTO agent_runs')) {
        return { rows: claimed ? [{ id: 'run-1' }] : [] };
      }
      return { rows: [{ id: 'step-row' }] };
    },
  } as unknown as Pool;
  return { pool, queries };
}

test('parses runner options and rejects invalid input', () => {
  const options = parseRunnerOptions(['--project', 'mainty', '--limit', '3', '--timeout-minutes', '5'], '/repo');
  assert.deepEqual([options.project, options.cwd, options.limit, options.timeoutMs], ['mainty', '/repo', 3, 300_000]);
  assert.throws(() => parseRunnerOptions([], '/repo'), /--project/);
  assert.throws(() => parseRunnerOptions(['--project', 'Bad Slug'], '/repo'), /--project/);
  assert.throws(() => parseRunnerOptions(['--project', 'm', '--item', 'x'], '/repo'), /UUID/);
  assert.throws(() => parseRunnerOptions(['--project', 'm', '--limit', '0'], '/repo'), /--limit/);
  assert.throws(() => parseRunnerOptions(['--project', 'm', '--shell', 'x'], '/repo'), /Unknown/);
});

test('appends the prompt or fills the {prompt} placeholder without a shell', () => {
  assert.deepEqual(buildInvocation(['claude', '-p'], 'Hi'), ['claude', '-p', 'Hi']);
  assert.deepEqual(buildInvocation(['tool', '--task', '{prompt}', '-v'], 'Hi'), ['tool', '--task', 'Hi', '-v']);
});

test('builds a prompt with instruction, order and previous results', () => {
  const prompt = buildPrompt(agent('Dev', 'while_task', 1, ['x']), item, [
    { agentName: 'Autor', phase: 'pre_task', status: 'passed', output: 'Spezifikation fertig' },
  ]);
  assert.match(prompt, /Dev macht etwas/);
  assert.match(prompt, /Titel: Sprints/);
  assert.match(prompt, /Autor \(pre_task, passed\)\nSpezifikation fertig/);
});

test('runs agents phase by phase in position order and marks the order done', async () => {
  const { pool, queries } = fakePool();
  const calls: string[][] = [];
  const execute: CommandExecutor = async (command) => {
    calls.push(command);
    return { exitCode: 0, durationMs: 1, output: `ok ${command[0]}` };
  };
  const agents = [
    agent('after', 'after_task', 1, ['c']),
    agent('while-2', 'while_task', 2, ['b2']),
    agent('pre', 'pre_task', 1, ['a']),
    agent('while-1', 'while_task', 1, ['b1']),
  ];
  const result = await runWorkItem(pool, item, agents, { cwd: '/repo', timeoutMs: 1000, execute });
  assert.equal(result, 'passed');
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['a', 'b1', 'b2', 'c'],
  );
  assert.match(calls[1]?.at(-1) ?? '', /ok a/);
  const itemUpdates = queries.filter((query) => query.sql.includes('UPDATE development_items'));
  assert.equal(itemUpdates[0]?.sql.includes("'in_progress'"), true);
  assert.deepEqual(itemUpdates.at(-1)?.values, ['item-1', 'done']);
});

test('stops at the first failing agent and blocks the order', async () => {
  const { pool, queries } = fakePool();
  const calls: string[] = [];
  const execute: CommandExecutor = async (command) => {
    calls.push(command[0] ?? '');
    return { exitCode: command[0] === 'b' ? 2 : 0, durationMs: 1, output: '' };
  };
  const agents = [
    agent('a', 'pre_task', 1, ['a']),
    agent('b', 'while_task', 1, ['b']),
    agent('c', 'after_task', 1, ['c']),
  ];
  const result = await runWorkItem(pool, item, agents, { cwd: '/repo', timeoutMs: 1000, execute });
  assert.equal(result, 'failed');
  assert.deepEqual(calls, ['a', 'b']);
  assert.deepEqual(queries.filter((query) => query.sql.includes('UPDATE development_items')).at(-1)?.values, [
    'item-1',
    'blocked',
  ]);
});

test('Laufwerk fällt während eines Agents weg: Auftrag wird neu eingeplant statt blockiert, kein Bug', async () => {
  const { mkdtempSync, renameSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const folder = mkdtempSync(join(tmpdir(), 'drive-'));
  const { pool, queries } = fakePool();
  const execute: CommandExecutor = async (command) => {
    // Agent b arbeitet, als das Laufwerk wegfällt (Ordner verschwindet): Befehl scheitert mit ENOENT.
    if (command[0] === 'b') renameSync(folder, `${folder}-weg`);
    return { exitCode: command[0] === 'b' ? 1 : 0, durationMs: 1, output: command[0] === 'b' ? 'spawn x ENOENT' : '' };
  };
  const agents = [agent('a', 'pre_task', 1, ['a']), agent('b', 'while_task', 1, ['b'])];
  const result = await runWorkItem(pool, item, agents, { cwd: folder, timeoutMs: 1000, execute });
  renameSync(`${folder}-weg`, folder);
  assert.equal(result, 'failed');
  const settled = queries.filter((query) => query.sql.includes('UPDATE development_items')).at(-1);
  assert.doesNotMatch(settled?.sql ?? '', /'blocked'/);
  assert.notDeepEqual(settled?.values, ['item-1', 'blocked']);
  assert.ok(!queries.some((query) => query.sql.includes('INSERT INTO bugs')), 'kein Bug-Bericht');
  const step = queries.find(
    (query) =>
      query.sql.includes('UPDATE agent_run_steps SET status') && String(query.values[3]).includes('Unterbrochen'),
  );
  assert.match(String(step?.values[3]), /ist nicht erreichbar|Ordner nicht erreichbar/);
});

test('uses the built-in agent for agents without command, hides DEV_LOG secrets and never double-runs an item', async () => {
  process.env.DEV_LOG_PASSWORD = 'secret-secret-secret';
  const { pool, queries } = fakePool();
  let environment: NodeJS.ProcessEnv | undefined;
  const execute: CommandExecutor = async (_command, _cwd, options) => {
    environment = options?.env;
    return { exitCode: 0, durationMs: 1, output: '' };
  };
  const builtinRoles: string[] = [];
  const builtin: BuiltinAgent = async ({ agent: current }) => {
    builtinRoles.push(current.name);
    return { exitCode: 0, durationMs: 1, output: 'built-in' };
  };
  const result = await runWorkItem(
    pool,
    item,
    [agent('manual', 'pre_task', 1, null), agent('dev', 'while_task', 1, ['x'])],
    { cwd: '/r', timeoutMs: 1, execute, builtin },
  );
  assert.equal(result, 'passed');
  assert.deepEqual(builtinRoles, ['manual']);
  assert.equal(environment?.DEV_LOG_PASSWORD, undefined);

  const busy = fakePool(false);
  assert.equal(
    await runWorkItem(busy.pool, item, [agent('dev', 'while_task', 1, ['x'])], {
      cwd: '/r',
      timeoutMs: 1,
      execute,
      builtin,
    }),
    'skipped',
  );
  assert.equal(
    busy.queries.some((query) => query.sql.includes('UPDATE development_items')),
    false,
  );
  delete process.env.DEV_LOG_PASSWORD;
  assert.ok(queries.length > 0);
});

test('puts known bugs into the prompt so mistakes are not repeated', () => {
  const prompt = buildPrompt(agent('Dev', 'while_task', 1, ['x']), item, [], {
    bugs: [
      {
        title: 'Login bricht ab',
        description: 'Null-Zeiger',
        severity: 'high',
        status: 'fixed',
        fixNotes: 'Prüfung ergänzt',
      },
      { title: 'Export leer', description: '', severity: 'low', status: 'open', fixNotes: '' },
    ],
  });
  assert.match(prompt, /\[behoben \/ high\] Login bricht ab – Null-Zeiger \| Lösung: Prüfung ergänzt/);
  assert.match(prompt, /\[offen \/ low\] Export leer/);
  assert.match(prompt, /Wiederhole diese Fehler nicht/);
});

test('stores documenter output, the handbook and reports a bug when an agent fails', async () => {
  const { pool, queries } = fakePool();
  const execute: CommandExecutor = async (command) => ({
    exitCode: command[0] === 'bad' ? 1 : 0,
    durationMs: 1,
    output: command[0] === 'manual' ? 'H'.repeat(300) : 'Doku fertig',
  });
  const roleAgent = (
    name: string,
    role: string,
    phase: string,
    position: number,
    command: string[],
  ): WorkflowAgent => ({
    ...agent(name, phase, position, command),
    role,
  });
  await runWorkItem(
    pool,
    item,
    [
      roleAgent('Doku', 'documenter', 'after_task', 1, ['doc']),
      roleAgent('Handbuch', 'manual_writer', 'after_task', 2, ['manual']),
    ],
    { cwd: '/r', timeoutMs: 1, execute },
  );
  assert.ok(queries.some((query) => query.sql.includes("'order'")));
  assert.ok(
    queries.some(
      (query) => query.sql.includes("'manual', 'sprint', 'repo'") && query.values.includes('Anwendungshandbuch'),
    ),
  );

  const failing = fakePool();
  await runWorkItem(failing.pool, item, [roleAgent('Dev', 'developer', 'while_task', 1, ['bad'])], {
    cwd: '/r',
    timeoutMs: 1,
    execute,
  });
  assert.ok(
    failing.queries.some((query) => query.sql.includes('INSERT INTO bugs') && String(query.values[1]).includes('Dev')),
  );
});

test('after a failed run only the failed agent and the following ones run again', async () => {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('INSERT INTO agent_runs')) return { rows: [{ id: 'run-2' }] };
      if (sql.includes('FROM agent_runs WHERE development_id')) return { rows: [{ id: 'run-1', status: 'failed' }] };
      if (sql.includes('FROM agent_run_steps WHERE run_id')) {
        return {
          rows: [
            { agent_id: 'pre-id', agent_name: 'pre', phase: 'pre_task', status: 'passed', output: 'fertig A' },
            { agent_id: 'while-id', agent_name: 'while', phase: 'while_task', status: 'failed', output: 'kaputt' },
          ],
        };
      }
      return { rows: [{ id: 'step-row' }] };
    },
  } as unknown as Pool;
  const calls: string[][] = [];
  const execute: CommandExecutor = async (command) => {
    calls.push(command);
    return { exitCode: 0, durationMs: 1, output: 'ok' };
  };
  const agents = [agent('pre', 'pre_task', 1, ['a']), agent('while', 'while_task', 1, ['b'])];
  assert.equal(await runWorkItem(pool, item, agents, { cwd: '/repo', timeoutMs: 1000, execute }), 'passed');
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['b'],
  );
  assert.match(calls[0]?.at(-1) ?? '', /fertig A/);
});

test('a failing reviewer (after_task) reports a bug; a failing documenter does not', async () => {
  const execute: CommandExecutor = async (command) => ({
    exitCode: command[0] === 'bad' ? 1 : 0,
    durationMs: 1,
    output: 'Änderungen nötig',
  });
  const roleAgent = (name: string, role: string, command: string[]): WorkflowAgent => ({
    ...agent(name, 'after_task', 1, command),
    role,
  });
  const reviewer = fakePool();
  await runWorkItem(reviewer.pool, item, [roleAgent('Reviewer', 'reviewer', ['bad'])], {
    cwd: '/r',
    timeoutMs: 1,
    execute,
  });
  assert.ok(
    reviewer.queries.some(
      (query) => query.sql.includes('INSERT INTO bugs') && String(query.values[1]).includes('Reviewer'),
    ),
  );

  const documenter = fakePool();
  await runWorkItem(documenter.pool, item, [roleAgent('Doku', 'documenter', ['bad'])], {
    cwd: '/r',
    timeoutMs: 1,
    execute,
  });
  assert.ok(!documenter.queries.some((query) => query.sql.includes('INSERT INTO bugs')));
});

test('a rejecting reviewer first sends the order back to the developer once within the same run', async () => {
  const roleAgent = (name: string, role: string, phase: string, command: string[]): WorkflowAgent => ({
    ...agent(name, phase, 1, command),
    role,
  });
  const agents = [
    roleAgent('Dev', 'developer', 'while_task', ['dev']),
    roleAgent('Review', 'reviewer', 'after_task', ['test']),
  ];
  // Erstes Review lehnt ab, nach der Nachbesserung Freigabe: kein Bug, Auftrag erledigt.
  const fixed = fakePool();
  const calls: string[][] = [];
  let testRuns = 0;
  const flaky: CommandExecutor = async (command) => {
    calls.push(command);
    if (command[0] !== 'test') return { exitCode: 0, durationMs: 1, output: `ok ${command[0]}` };
    testRuns += 1;
    return {
      exitCode: testRuns === 1 ? 1 : 0,
      durationMs: 1,
      output: testRuns === 1 ? '@@REVIEW: ÄNDERUNGEN NÖTIG\nTest X rot' : '@@REVIEW: FREIGEGEBEN',
    };
  };
  assert.equal(await runWorkItem(fixed.pool, item, agents, { cwd: '/r', timeoutMs: 1, execute: flaky }), 'passed');
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['dev', 'test', 'dev', 'test'],
  );
  assert.match(calls[2]?.at(-1) ?? '', /Rückmeldung von Review[\s\S]*Test X rot/);
  assert.ok(!fixed.queries.some((query) => query.sql.includes('INSERT INTO bugs')));
  const positions = fixed.queries
    .filter((query) => query.sql.includes('INSERT INTO agent_run_steps'))
    .map((query) => query.values[1]);
  assert.deepEqual(positions, [0, 1, 2, 3]);

  // Lehnt der Reviewer erneut ab, gibt es genau eine Nachbesserung und danach den Bug-Bericht.
  const broken = fakePool();
  const brokenCalls: string[] = [];
  const failing: CommandExecutor = async (command) => {
    brokenCalls.push(command[0] ?? '');
    return { exitCode: command[0] === 'test' ? 1 : 0, durationMs: 1, output: 'rot' };
  };
  assert.equal(await runWorkItem(broken.pool, item, agents, { cwd: '/r', timeoutMs: 1, execute: failing }), 'failed');
  assert.deepEqual(brokenCalls, ['dev', 'test', 'dev', 'test']);
  assert.equal(broken.queries.filter((query) => query.sql.includes('INSERT INTO bugs')).length, 1);
});

test('a transient failure (model unreachable) is retried once before the order blocks', async () => {
  const flaky = fakePool();
  let calls = 0;
  const execute: CommandExecutor = async () => {
    calls += 1;
    return calls === 1
      ? { exitCode: 1, durationMs: 1, output: 'Fehler: Ollama nicht erreichbar' }
      : { exitCode: 0, durationMs: 1, output: 'fertig' };
  };
  const options = { cwd: '/r', timeoutMs: 1, execute, transientRetryDelayMs: 0 };
  assert.equal(await runWorkItem(flaky.pool, item, [agent('dev', 'while_task', 1, ['x'])], options), 'passed');
  assert.equal(calls, 2);

  // Ein echter Fehler (kein vorübergehender) wird nicht wiederholt.
  const broken = fakePool();
  let brokenCalls = 0;
  const failing: CommandExecutor = async () => {
    brokenCalls += 1;
    return { exitCode: 1, durationMs: 1, output: 'TypeError: x is undefined' };
  };
  await runWorkItem(broken.pool, item, [agent('dev', 'while_task', 1, ['x'])], { ...options, execute: failing });
  assert.equal(brokenCalls, 1);
});

test('the cost brake stops an order before the next agent once its limit is reached', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('INSERT INTO agent_runs')) return { rows: [{ id: 'run-1' }] };
      if (sql.includes('INSERT INTO agent_run_steps')) return { rows: [{ id: 'step-1' }] };
      if (sql.includes('order_token_limit')) return { rows: [{ tokens: '1000', cost: null }] };
      if (sql.includes('SUM(s.tokens)')) return { rows: [{ tokens: queries.length > 0 ? '1500' : '0', cost: '0' }] };
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  const calls: string[] = [];
  const execute: CommandExecutor = async (command) => {
    calls.push(command[0] ?? '');
    return { exitCode: 0, durationMs: 1, output: '' };
  };
  const result = await runWorkItem(pool, item, [agent('dev', 'while_task', 1, ['dev'])], {
    cwd: '/r',
    timeoutMs: 1,
    execute,
  });
  assert.equal(result, 'failed');
  assert.deepEqual(calls, []);
  assert.ok(
    queries.some((query) => query.sql.includes('action_todo') && String(query.values[1]).includes('Kostengrenze')),
  );
  assert.ok(!queries.some((query) => query.sql.includes('INSERT INTO bugs')));
});

test('Workflow-Reihenfolge: der Auftrag läuft genau wie im Board – Spalte für Spalte, darin nach Position', async () => {
  const { pool } = fakePool();
  const calls: string[] = [];
  const execute: CommandExecutor = async (command) => {
    calls.push(command[0] ?? '');
    return { exitCode: 0, durationMs: 1, output: '' };
  };
  // Absichtlich durcheinander geliefert; dieselbe Karte darf an mehreren Stellen stehen (Tester zweimal).
  const agents = [
    agent('test-2', 'on_done', 1, ['test-2']),
    agent('doc', 'after_task', 2, ['doc']),
    agent('test', 'after_task', 1, ['test']),
    agent('dev', 'while_task', 1, ['dev']),
    agent('prep', 'pre_task', 1, ['prep']),
    agent('plan', 'pre_sprint', 1, ['plan']),
  ];
  assert.equal(await runWorkItem(pool, item, agents, { cwd: '/repo', timeoutMs: 1000, execute }), 'passed');
  assert.deepEqual(calls, ['prep', 'dev', 'test', 'doc', 'test-2']);
});
