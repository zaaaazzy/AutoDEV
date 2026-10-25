import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import type { CommandExecutor } from '../core/command.js';
import {
  budgetHold,
  type BuiltinAgent,
  buildInvocation,
  buildPrompt,
  closeOrphanedRuns,
  heldRunIds,
  isDatabaseUnavailable,
  ORPHANED_REQUEUE_LIMIT,
  ORPHANED_RUN_MS,
  parseRunnerOptions,
  retryOnDatabase,
  recoverStuckItems,
  runSelectedItems,
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
      if (sql.includes('FROM budgets')) return { rows: [{ period: 'order', maxTokens: '1000', maxCostUsd: null }] };
      if (sql.includes('SUM(s.tokens)')) return { rows: [{ tokens: '1500', cost: '0', since: null }] };
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
    queries.some(
      (query) => query.sql.includes('SET action_todo') && String(query.values[1]).startsWith('Budget erreicht'),
    ),
  );
  // Der Zeitraum, der blockiert, wird gemerkt – so gibt ein höheres Limit den Auftrag wieder frei.
  assert.ok(queries.some((query) => query.sql.includes('budget_blocked = $3') && query.values[2] === 'order'));
  assert.ok(queries.some((query) => query.sql.includes('status = CASE') && query.values[1] === 'blocked'));
  assert.ok(!queries.some((query) => query.sql.includes('INSERT INTO bugs')));
});

test('Modell-Routing: ein docs-Auftrag läuft lokal, nach einem Fehlschlag mit dem starken Modell', async () => {
  const run = async (retryCount: number) => {
    const queries: { sql: string; values: unknown[] }[] = [];
    const pool = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes('INSERT INTO agent_runs')) return { rows: [{ id: 'run-1' }] };
        if (sql.includes('INSERT INTO agent_run_steps')) return { rows: [{ id: 'step-1' }] };
        if (sql.includes('routing_local_model'))
          return { rows: [{ customized: false, local: 'qwen3.5:9b', strong: ['claude', '-p', '--model', 'opus'] }] };
        return { rows: [], rowCount: 1 };
      },
    } as unknown as Pool;
    const commands: string[][] = [];
    const models: (string | undefined)[] = [];
    const execute: CommandExecutor = async (command) => {
      commands.push(command);
      return { exitCode: 0, durationMs: 1, output: 'ok' };
    };
    const builtin: BuiltinAgent = async ({ model }) => {
      models.push(model);
      return { exitCode: 0, durationMs: 1, output: 'ok', tokens: 10 };
    };
    const developer = { ...agent('Entwickler', 'while_task', 1, ['dev']), role: 'developer' };
    await runWorkItem(pool, { ...item, category: 'docs', effortHours: 2, retryCount }, [developer], {
      cwd: '/r',
      timeoutMs: 1,
      execute,
      builtin,
    });
    const step = queries.find((query) => query.sql.includes('INSERT INTO agent_run_steps'));
    return { commands, models, model: step?.values[6], rule: step?.values[7] };
  };
  const local = await run(0);
  assert.deepEqual(local.models, ['qwen3.5:9b']);
  assert.deepEqual(local.commands, []);
  assert.deepEqual([local.model, local.rule], ['qwen3.5:9b', 'docs → lokal']);

  const escalated = await run(1);
  assert.deepEqual(escalated.models, []);
  assert.equal(escalated.commands[0]?.[0], 'claude');
  assert.ok(escalated.commands[0]?.join(' ').includes('--model opus'));
  assert.deepEqual([escalated.model, escalated.rule], ['claude (opus)', 'docs → lokal · retry ≥ 1 → eine Stufe höher']);
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

test('Workflow-Schritte: derselbe Agent zweimal, je mit eigener Anweisung; Nachricht erreicht den richtigen Einsatz', async () => {
  const { pool, queries } = fakePool();
  const prompts: string[] = [];
  const execute: CommandExecutor = async (command) => {
    prompts.push(command.at(-1) ?? '');
    return {
      exitCode: 0,
      durationMs: 1,
      output: prompts.length === 2 ? 'Getestet.\n@@NACHRICHT: Nur noch die Doku prüfen.' : 'ok',
    };
  };
  const tester = agent('Tester', 'after_task', 1, ['tester']);
  const agents = [
    agent('Entwickler', 'while_task', 1, ['dev']),
    { ...tester, stepId: 'step-1', stepInstructions: 'Teste nur die API.' },
    { ...tester, position: 2, stepId: 'step-2', stepInstructions: 'Teste jetzt die Oberfläche.' },
  ];
  assert.equal(await runWorkItem(pool, item, agents, { cwd: '/repo', timeoutMs: 1000, execute }), 'passed');
  assert.equal(prompts.length, 3);
  assert.match(prompts[1]!, /## Anweisung für diesen Schritt \(hat Vorrang\)\nTeste nur die API\./);
  assert.match(prompts[2]!, /Teste jetzt die Oberfläche\./);
  assert.doesNotMatch(prompts[2]!, /Teste nur die API/);
  assert.match(prompts[2]!, /## Nachrichten an dich\n- Von Tester: Nur noch die Doku prüfen\./);
  // Jeder Einsatz wird mit seinem Workflow-Schritt protokolliert.
  const inserted = queries.filter((query) => query.sql.includes('INSERT INTO agent_run_steps')).map((q) => q.values[5]);
  assert.deepEqual(inserted, [null, 'step-1', 'step-2']);
});

test('Nachbesserung: der Entwickler setzt seine Claude-Sitzung fort statt neu zu beginnen', async () => {
  const sessions: string[] = [];
  const queries: string[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push(sql);
      if (sql.includes('INSERT INTO agent_runs')) return { rows: [{ id: 'run-1' }] };
      if (sql.includes('SET session_id')) {
        sessions.push(String(values[1]));
        return { rows: [] };
      }
      if (sql.includes('s.session_id AS "sessionId"'))
        return { rows: sessions.length ? [{ sessionId: sessions.at(-1), status: 'passed' }] : [] };
      return { rows: [{ id: 'step-row' }] };
    },
  } as unknown as Pool;
  const agents: WorkflowAgent[] = [
    { ...agent('Dev', 'while_task', 1, ['claude', '-p']), role: 'developer' },
    { ...agent('Review', 'after_task', 1, ['review']), role: 'reviewer' },
  ];
  const calls: string[][] = [];
  let reviews = 0;
  const execute: CommandExecutor = async (command, _cwd, options) => {
    calls.push(command);
    if (command[0] === 'review') {
      reviews += 1;
      return reviews === 1
        ? { exitCode: 1, durationMs: 1, output: '@@REVIEW: ÄNDERUNGEN NÖTIG\nKnopf fehlt' }
        : { exitCode: 0, durationMs: 1, output: '@@REVIEW: FREIGEGEBEN' };
    }
    const raw = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sitzung-1' }),
      JSON.stringify({ type: 'result', result: 'fertig', usage: {} }),
      '',
    ].join('\n');
    options?.onChunk?.(raw);
    return { exitCode: 0, durationMs: 1, output: raw };
  };
  assert.equal(await runWorkItem(pool, item, agents, { cwd: '/r', timeoutMs: 1, execute }), 'passed');
  const developer = calls.filter((call) => call[0] === 'claude');
  assert.equal(developer.length, 2);
  // Erster Lauf frisch, die Sitzung wird sofort gespeichert; die Nachbesserung setzt sie fort.
  assert.ok(!developer[0]!.includes('--resume'));
  assert.equal(sessions[0], 'sitzung-1');
  assert.deepEqual(developer[1]!.slice(developer[1]!.indexOf('--resume'), developer[1]!.indexOf('--resume') + 2), [
    '--resume',
    'sitzung-1',
  ]);
  assert.match(developer[1]!.at(-1) ?? '', /Fortsetzung deiner früheren Sitzung[\s\S]*Knopf fehlt/);
});

test('Fortsetzen scheitert (Sitzung weg): derselbe Schritt startet frisch mit dem vollen Auftrag', async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('INSERT INTO agent_runs')) return { rows: [{ id: 'run-1' }] };
      if (sql.includes('s.session_id AS "sessionId"')) return { rows: [{ sessionId: 'alt', status: 'failed' }] };
      return { rows: [{ id: 'step-row' }] };
    },
  } as unknown as Pool;
  const calls: string[][] = [];
  const execute: CommandExecutor = async (command, _cwd, options) => {
    calls.push(command);
    if (command.includes('--resume')) {
      return { exitCode: 1, durationMs: 1, output: 'No conversation found with session ID: alt' };
    }
    // Ohne result-Ereignis gälte der Lauf als fehlgeschlagen.
    options?.onChunk?.(`${JSON.stringify({ type: 'result', result: 'ok' })}\n`);
    return { exitCode: 0, durationMs: 1, output: 'ok' };
  };
  const agents = [{ ...agent('Dev', 'while_task', 1, ['claude', '-p']), role: 'developer' }];
  assert.equal(await runWorkItem(pool, item, agents, { cwd: '/r', timeoutMs: 1, execute }), 'passed');
  assert.equal(calls.length, 2);
  assert.ok(calls[0]!.includes('--resume'));
  assert.match(calls[0]!.at(-1) ?? '', /abgebrochen/);
  assert.ok(!calls[1]!.includes('--resume'));
  assert.doesNotMatch(calls[1]!.at(-1) ?? '', /Fortsetzung/);
});

test('Tester schreibt Tests: der Prozess wird als PID des Schritts gemeldet, damit ein Abbruch ihn beendet', async () => {
  process.env.DEV_LOG_AGENT_COMMAND = '["fake-agent"]';
  const { pool, queries } = fakePool();
  const execute: CommandExecutor = async (_command, _cwd, options) => {
    options?.onSpawn?.(4242);
    return { exitCode: 0, durationMs: 1, output: 'Tests geschrieben' };
  };
  const builtin: BuiltinAgent = async () => ({ exitCode: 0, durationMs: 1, output: 'Tests grün' });
  const tester = { ...agent('Tester', 'after_task', 1, null), role: 'tester' as const };
  try {
    assert.equal(await runWorkItem(pool, item, [tester], { cwd: '/r', timeoutMs: 1, execute, builtin }), 'passed');
  } finally {
    delete process.env.DEV_LOG_AGENT_COMMAND;
  }
  assert.ok(
    queries.some((query) => query.sql.includes('SET pid = $2') && query.values[1] === 4242),
    'PID des Testschreibers wird gespeichert',
  );
});

test('Entwickler: geänderte Dateien landen am Auftrag und als Abschnitt in seiner Ausgabe; der Tester bekommt sie', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { runCommand } = await import('../core/command.js');
  const cwd = mkdtempSync(join(tmpdir(), 'changed-run-'));
  const run = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  run('init', '-b', 'main');
  run('config', 'user.email', 'a@b.c');
  run('config', 'user.name', 'a');
  writeFileSync(join(cwd, 'base.txt'), 'base');
  run('add', '-A');
  run('commit', '-m', 'base');
  const { pool, queries } = fakePool();
  const execute: CommandExecutor = async (command, directory, options) => {
    if (command[0] !== 'dev') return runCommand(command, directory, options);
    writeFileSync(join(cwd, 'neu.ts'), 'export {}');
    return { exitCode: 0, durationMs: 1, output: 'Fertig.' };
  };
  let testerFiles: string[] | undefined;
  const builtin: BuiltinAgent = async ({ changedFiles }) => {
    testerFiles = changedFiles;
    return { exitCode: 0, durationMs: 1, output: 'Tests grün' };
  };
  const developer = { ...agent('Entwickler', 'while_task', 1, ['dev']), role: 'developer' };
  const tester = { ...agent('Tester', 'while_task', 2, null), role: 'tester' };
  const result = await runWorkItem(pool, item, [developer, tester], { cwd, timeoutMs: 5000, execute, builtin });
  assert.equal(result, 'passed');
  assert.ok(
    queries.some(
      (query) =>
        query.sql.includes('SET changed_files') && JSON.stringify(query.values[1]) === JSON.stringify(['neu.ts']),
    ),
    'geänderte Dateien am Auftrag gespeichert',
  );
  const developerStep = queries.find(
    (query) => query.sql.includes('UPDATE agent_run_steps SET status') && String(query.values[4]).startsWith('Fertig.'),
  );
  assert.match(String(developerStep?.values[4]), /## Geänderte Dateien\n- neu\.ts/);
  assert.deepEqual(testerFiles, ['neu.ts']);
});

test('Sprint pausiert: der Entwickler beendet seinen Schritt, der Tester startet erst nach dem Fortsetzen', async () => {
  let paused = false;
  let previousSteps: object[] = [];
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('INSERT INTO agent_runs')) return { rows: [{ id: `run-${queries.length}` }] };
      if (sql.includes('paused_at IS NOT NULL AS paused')) return { rows: [{ paused }] };
      if (sql.includes('FROM agent_runs WHERE development_id'))
        return { rows: previousSteps.length ? [{ id: 'run-old', status: 'failed' }] : [] };
      if (sql.includes('FROM agent_run_steps WHERE run_id')) return { rows: previousSteps };
      return { rows: [{ id: 'step-row' }], rowCount: 1 };
    },
  } as unknown as Pool;
  const calls: string[] = [];
  const execute: CommandExecutor = async (command) => {
    calls.push(command[0] ?? '');
    // Während der Entwickler arbeitet, pausiert jemand den Sprint.
    if (command[0] === 'dev') paused = true;
    return { exitCode: 0, durationMs: 1, output: 'erledigt' };
  };
  const agents = [agent('dev', 'while_task', 1, ['dev']), agent('tester', 'after_task', 1, ['tester'])];
  const sprintItem = { ...item, sprintId: 'sprint-1' };
  const options = { cwd: '/r', timeoutMs: 1, execute };

  assert.equal(await runWorkItem(pool, sprintItem, agents, options), 'failed');
  assert.deepEqual(calls, ['dev'], 'der Tester startet nicht mehr');
  assert.ok(
    queries.some((query) => /SET status = 'planned'/.test(query.sql)),
    'Auftrag wieder „Geplant“',
  );
  assert.ok(!queries.some((query) => query.values.includes('blocked') || query.values.includes('done')));
  assert.ok(!queries.some((query) => query.sql.includes('INSERT INTO bugs')), 'kein Bug');

  // Fortsetzen: der nächste Lauf überspringt den erfolgreichen Entwickler und startet beim Tester.
  paused = false;
  previousSteps = [
    { agent_id: 'dev-id', agent_name: 'dev', phase: 'while_task', status: 'passed', output: 'erledigt' },
  ];
  calls.length = 0;
  assert.equal(await runWorkItem(pool, sprintItem, agents, options), 'passed');
  assert.deepEqual(calls, ['tester']);
});

test('Fortsetzung nach Nachbesserung und frühem Abbruch: der Entwickler bekommt die letzte Rückmeldung des Testers', async () => {
  // Vorheriger Lauf: Entwickler, Tester ✗ (Nachbesserung), Entwickler, Tester ✗ – danach abgebrochen, also nicht mehr
  // Zeilen als Agents im Ablauf (4).
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('INSERT INTO agent_runs')) return { rows: [{ id: 'run-2' }] };
      if (sql.includes('FROM agent_runs WHERE development_id')) return { rows: [{ id: 'run-1', status: 'failed' }] };
      if (sql.includes('FROM agent_run_steps WHERE run_id')) {
        const step = (id: string, name: string, phase: string, status: string, output: string) => ({
          agent_id: id,
          workflow_step_id: null,
          agent_name: name,
          phase,
          status,
          output,
        });
        return {
          rows: [
            step('dev-id', 'dev', 'while_task', 'passed', 'gebaut'),
            step('tester-id', 'tester', 'after_task', 'failed', 'erste Rückmeldung'),
            step('dev-id', 'dev', 'while_task', 'passed', 'nachgebessert'),
            step('tester-id', 'tester', 'after_task', 'failed', 'zweite Rückmeldung'),
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
  const agents = [
    { ...agent('dev', 'while_task', 1, ['dev']), role: 'developer' },
    { ...agent('tester', 'after_task', 1, ['tester']), role: 'tester' },
    agent('doc', 'after_task', 2, ['doc']),
    agent('check', 'after_task', 3, ['check']),
  ];
  await runWorkItem(pool, item, agents, { cwd: '/repo', timeoutMs: 1000, execute });
  assert.equal(calls[0]?.[0], 'dev');
  assert.match(calls[0]?.at(-1) ?? '', /zweite Rückmeldung/);
  assert.doesNotMatch(calls[0]?.at(-1) ?? '', /erste Rückmeldung/);
});

/** Ein Schritt dieses Laufs wird als unterbrochen markiert (nicht: claimRun räumt verwaiste Läufe ab). */
const marksStepInterrupted = (sql: string) => sql.includes('interrupted = TRUE') && sql.includes('WHERE id = $1');

/** Vorheriger, gescheiterter Lauf: Entwickler bestanden, danach `last` (Tester oder Reviewer) gescheitert. */
function previousRunPool(last: { role: string; interrupted: boolean }) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('INSERT INTO agent_runs')) return { rows: [{ id: 'run-2' }] };
      if (sql.includes('FROM agent_runs WHERE development_id')) return { rows: [{ id: 'run-1', status: 'failed' }] };
      if (sql.includes('FROM agent_run_steps WHERE run_id')) {
        return {
          rows: [
            { agent_id: 'dev-id', agent_name: 'dev', phase: 'while_task', status: 'passed', output: 'gebaut' },
            {
              agent_id: `${last.role}-id`,
              agent_name: last.role,
              phase: 'after_task',
              status: 'failed',
              output: last.interrupted ? 'halb fertig\nUnterbrochen: Der Worker wurde beendet.' : 'Test X rot',
              interrupted: last.interrupted,
            },
          ],
        };
      }
      return { rows: [{ id: 'step-row' }] };
    },
  } as unknown as Pool;
  return { pool, queries };
}

for (const role of ['tester', 'reviewer']) {
  const agents = [
    { ...agent('dev', 'while_task', 1, ['dev']), role: 'developer' },
    { ...agent(role, 'after_task', 1, [role]), role },
  ];
  const ok = role === 'reviewer' ? '@@REVIEW: FREIGEGEBEN' : 'ok';

  test(`Unterbrechung im ${role}-Schritt: der nächste Lauf setzt beim selben Agent fort, der Entwickler bleibt übernommen`, async () => {
    const { pool } = previousRunPool({ role, interrupted: true });
    const calls: string[][] = [];
    const execute: CommandExecutor = async (command) => {
      calls.push(command);
      return { exitCode: 0, durationMs: 1, output: ok };
    };
    await runWorkItem(pool, item, agents, { cwd: '/repo', timeoutMs: 1000, execute });
    // Der Tester führt danach die Projekttests aus (hier ohne Projekt rot); entscheidend ist, wer zuerst startet.
    assert.equal(calls[0]?.[0], role, 'derselbe Agent setzt fort, nicht der Entwickler');
    assert.match(calls[0]?.at(-1) ?? '', /gebaut/);
    assert.doesNotMatch(calls[0]?.at(-1) ?? '', /bitte beheben/);
  });

  test(`echte Ablehnung im ${role}-Schritt: der nächste Lauf beginnt beim Entwickler mit der Rückmeldung`, async () => {
    const { pool } = previousRunPool({ role, interrupted: false });
    const calls: string[][] = [];
    const execute: CommandExecutor = async (command) => {
      calls.push(command);
      return { exitCode: 0, durationMs: 1, output: ok };
    };
    await runWorkItem(pool, item, agents, { cwd: '/repo', timeoutMs: 1000, execute });
    assert.deepEqual(
      calls.slice(0, 2).map((call) => call[0]),
      ['dev', role],
    );
    assert.match(calls[0]?.at(-1) ?? '', /bitte beheben:\nTest X rot/);
  });
}

test('nach der Fortsetzung lehnt der Tester wirklich ab: zurück an den Entwickler, das Kennzeichen bleibt nicht hängen', async () => {
  const { pool, queries } = previousRunPool({ role: 'tester', interrupted: true });
  const calls: string[][] = [];
  let testerRuns = 0;
  const execute: CommandExecutor = async (command) => {
    calls.push(command);
    if (command[0] !== 'tester') return { exitCode: 0, durationMs: 1, output: 'ok' };
    testerRuns += 1;
    return { exitCode: testerRuns === 1 ? 1 : 0, durationMs: 1, output: testerRuns === 1 ? 'Test Y rot' : 'ok' };
  };
  const agents = [
    { ...agent('dev', 'while_task', 1, ['dev']), role: 'developer' },
    { ...agent('tester', 'after_task', 1, ['tester']), role: 'tester' },
  ];
  await runWorkItem(pool, item, agents, { cwd: '/repo', timeoutMs: 1000, execute });
  assert.deepEqual(
    calls.slice(0, 3).map((call) => call[0]),
    ['tester', 'dev', 'tester'],
  );
  assert.match(calls[1]?.at(-1) ?? '', /Rückmeldung von tester[\s\S]*Test Y rot/);
  assert.ok(!queries.some((query) => marksStepInterrupted(query.sql)), 'kein Schritt als unterbrochen markiert');
});

test('ausgewählter Auftrag inzwischen abgelehnt oder aus dem Sprint genommen: er startet nicht, der Lauf wird verworfen', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('INSERT INTO agent_runs')) return { rows: [{ id: 'run-1' }], rowCount: 1 };
      // Der bedingte Start trifft nichts mehr: Status ist nicht mehr „Geplant“.
      if (sql.includes("SET status = 'in_progress'")) return { rows: [], rowCount: 0 };
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
  assert.equal(result, 'skipped');
  assert.deepEqual(calls, []);
  const start = queries.find((query) => query.sql.includes("SET status = 'in_progress'"));
  assert.match(start?.sql ?? '', /d\.status = 'planned'/);
  assert.deepEqual(start?.values, ['item-1', false]);
  assert.ok(queries.some((query) => query.sql.includes('DELETE FROM agent_runs') && query.values[0] === 'run-1'));
  assert.ok(
    !queries.some((query) => query.sql.includes('UPDATE agent_runs SET status = $2')),
    'kein gescheiterter Lauf',
  );
});

test('ein Auftrag scheitert unerwartet (z. B. gelöscht): die übrigen ausgewählten Aufträge laufen weiter', async () => {
  const items = ['a', 'b', 'c'].map((id) => ({ ...item, id }));
  const ran: string[] = [];
  let between = 0;
  const results = await runSelectedItems(
    items,
    async (current) => {
      ran.push(current.id);
      if (current.id === 'b') throw new Error('insert or update on table "agent_runs" violates foreign key constraint');
      return 'passed';
    },
    async () => {
      between += 1;
    },
  );
  assert.deepEqual(ran, ['a', 'b', 'c']);
  assert.deepEqual(
    results.map((entry) => entry.result),
    ['passed', 'failed', 'passed'],
  );
  assert.equal(between, 2);
});

test('Budget mitten im Zyklus erreicht: ein Auftrag wartet sichtbar, die übrigen bleiben eingeplant', async () => {
  let spent = 0;
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('FROM budgets')) return { rows: [{ period: 'day', maxTokens: '1000', maxCostUsd: null }] };
      if (sql.includes('to_char(CURRENT_DATE')) return { rows: [{ key: '2026-10-20', since: '2026-10-20' }] };
      if (sql.includes('FROM agent_run_steps s JOIN agent_runs r'))
        return { rows: [{ tokens: String(spent), cost: '0' }] };
      if (sql.includes("SET status = 'blocked'")) return { rows: [{ id: values[0] }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const items = ['a', 'b', 'c'].map((id) => ({ ...item, id }));
  const ran: string[] = [];
  const results = await runSelectedItems(
    items,
    async (current) => {
      ran.push(current.id);
      spent = 1500; // Auftrag a verbraucht das Tageslimit.
      return 'passed';
    },
    undefined,
    budgetHold(pool, 'mainty'),
  );
  assert.deepEqual(ran, ['a']);
  assert.deepEqual(results, [{ itemId: 'a', result: 'passed' }]);
  const blocked = queries
    .filter((query) => query.sql.includes("SET status = 'blocked'"))
    .map((query) => query.values[0]);
  assert.deepEqual(blocked, ['b'], 'nur der nächste Auftrag wartet, c bleibt eingeplant');
});

test('Datenbank-Aussetzer beim Abschluss: der Auftrag bleibt nicht „In Arbeit“ hängen, der Lauf endet erst danach', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  let outage = false;
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('INSERT INTO agent_runs')) return { rows: [{ id: 'run-1' }], rowCount: 1 };
      // Abschluss (settleItem) und Lauf-Status scheitern: die Datenbank ist kurz weg.
      if (outage && (sql.includes('status = CASE') || sql.includes('UPDATE agent_runs SET status = $2')))
        throw new Error('Connection terminated unexpectedly');
      return { rows: [{ id: 'step-row' }], rowCount: 1 };
    },
  } as unknown as Pool;
  const execute: CommandExecutor = async () => {
    outage = true;
    return { exitCode: 0, durationMs: 1, output: 'ok' };
  };
  const result = await runWorkItem(pool, item, [agent('dev', 'while_task', 1, ['dev'])], {
    cwd: '/r',
    timeoutMs: 1,
    execute,
    settleRetryDelayMs: 0,
  });
  assert.equal(result, 'failed');
  const stuck = queries.findIndex(
    (query) => query.sql.includes("SET status = 'blocked', failure = COALESCE") && query.values[0] === 'item-1',
  );
  assert.ok(stuck >= 0, 'Auftrag wird blockiert statt in Arbeit zu bleiben');
  const run = queries.findIndex((query) => query.sql.includes('UPDATE agent_runs SET status = $2'));
  assert.ok(run > stuck, 'der Lauf wird erst nach dem Abschluss beendet');
  assert.equal(queries[run]?.values[1], 'failed');
});

/** Wie pg bei ausgefallener Datenbank: AggregateError ohne Text, der Code steckt in den Einzelfehlern. */
function refused(): Error {
  return new AggregateError([
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
  ]);
}

test('Datenbank kommt während des Abschlusses zurück: Auftrag und Lauf werden nach Pausen doch noch geschlossen', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  let outage = false;
  let failures = 0;
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('INSERT INTO agent_runs')) return { rows: [{ id: 'run-1' }], rowCount: 1 };
      // settleItem scheitert endgültig; Blockieren und Lauf-Status scheitern je zweimal, dann ist die Datenbank zurück.
      if (outage && sql.includes('status = CASE')) throw refused();
      const closing =
        sql.includes("SET status = 'blocked', failure = COALESCE") || sql.includes('UPDATE agent_runs SET status = $2');
      if (outage && closing && failures < 4) {
        failures += 1;
        throw refused();
      }
      return { rows: [{ id: 'step-row' }], rowCount: 1 };
    },
  } as unknown as Pool;
  const execute: CommandExecutor = async () => {
    outage = true;
    return { exitCode: 0, durationMs: 1, output: 'ok' };
  };
  const result = await runWorkItem(pool, item, [agent('dev', 'while_task', 1, ['dev'])], {
    cwd: '/r',
    timeoutMs: 1,
    execute,
    settleRetryDelayMs: 0,
  });
  assert.equal(result, 'failed');
  const blocks = queries.filter((query) => query.sql.includes("SET status = 'blocked', failure = COALESCE"));
  const closes = queries.filter((query) => query.sql.includes('UPDATE agent_runs SET status = $2'));
  assert.ok(blocks.length >= 2, 'Blockieren wird nach dem Datenbankfehler wiederholt');
  assert.equal(failures, 4);
  assert.equal(closes.at(-1)?.values[1], 'failed', 'der Lauf steht am Ende nicht mehr auf „läuft“');
  assert.deepEqual(heldRunIds(), [], 'der Worker hält den Lauf danach nicht mehr');
});

test('SQL-Fehler beim Abschluss werden nicht wiederholt, nur Datenbankausfälle', async () => {
  let calls = 0;
  await assert.rejects(
    retryOnDatabase(async () => {
      calls += 1;
      throw Object.assign(new Error('syntax error'), { code: '42601' });
    }, 0),
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    retryOnDatabase(async () => {
      calls += 1;
      throw refused();
    }, 0),
  );
  assert.equal(calls, 5, 'begrenzt: nach fünf Versuchen gibt der Abschluss auf');
  assert.ok(isDatabaseUnavailable(new Error('Connection terminated unexpectedly')));
  assert.ok(isDatabaseUnavailable(Object.assign(new Error('terminating connection'), { code: '57P01' })));
  assert.ok(!isDatabaseUnavailable(new Error('duplicate key')));
});

test('Abschluss scheitert endgültig: der verwaiste Lauf wird im Zyklus beendet, ohne Neustart; Abbrechen wirkt sofort', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  let outage = false;
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('INSERT INTO agent_runs')) return { rows: [{ id: 'run-1' }], rowCount: 1 };
      const closing = /status = CASE|SET status = 'blocked', failure = COALESCE|UPDATE agent_runs SET status = \$2/;
      if (outage && closing.test(sql)) throw refused();
      if (sql.includes('WITH candidates')) return { rows: [{ count: 1 }], rowCount: 1 };
      return { rows: [{ id: 'step-row' }], rowCount: 1 };
    },
  } as unknown as Pool;
  const execute: CommandExecutor = async () => {
    outage = true;
    return { exitCode: 0, durationMs: 1, output: 'ok' };
  };
  await runWorkItem(pool, item, [agent('dev', 'while_task', 1, ['dev'])], {
    cwd: '/r',
    timeoutMs: 1,
    execute,
    settleRetryDelayMs: 0,
  });
  // Der Lauf blieb in der Datenbank „läuft“, gehalten wird er aber nicht mehr – das Aufräumen darf ihn nehmen.
  assert.deepEqual(heldRunIds(), []);
  outage = false;
  assert.equal(await closeOrphanedRuns(pool, ['mainty']), 1);
  const sweep = queries.find((query) => query.sql.includes('WITH candidates'));
  assert.ok(sweep);
  const [projects, held, staleMs, cancelMs, note, cancelNote, limit] = sweep.values;
  assert.deepEqual(projects, ['mainty']);
  assert.deepEqual(held, [], 'nur Läufe, die kein Auftrag dieses Workers hält');
  assert.equal(staleMs, ORPHANED_RUN_MS, 'nur ohne frisches Lebenszeichen');
  assert.ok((cancelMs as number) < (staleMs as number), 'ein abgebrochener Schritt endet ohne langes Warten');
  assert.match(note as string, /^Unterbrochen: /);
  assert.match(cancelNote as string, /abgebrochen/);
  assert.equal(limit, ORPHANED_REQUEUE_LIMIT);
  const sql = sweep.sql;
  assert.match(sql, /NOT \(r\.id::text = ANY\(\$2::text\[\]\)\)/);
  assert.match(sql, /WHERE r\.id = o\.id AND r\.status = 'running'/, 'bedingt: nur Läufe, die noch laufen');
  assert.match(sql, /s\.status = 'running'/);
  assert.match(sql, /interrupted = NOT runs\.cancelled/, 'Unterbrechung setzt beim selben Agent fort');
  assert.match(sql, /exit_code = CASE WHEN runs\.cancelled THEN 130/);
  assert.match(sql, /WHEN st\.block THEN 'blocked' ELSE 'planned'/, 'wieder eingeplant, begrenzt');
  assert.match(sql, /d\.status = 'in_progress'/);
  assert.doesNotMatch(sql, /tokens|cost_usd/, 'Tokens und Kosten bleiben unberührt');
  // Ein Lauf, den der Worker noch hält, wird nie angefasst.
  await closeOrphanedRuns(pool, ['mainty'], ['run-2']);
  assert.deepEqual(queries.filter((query) => query.sql.includes('WITH candidates')).at(-1)?.values[1], ['run-2']);
  assert.equal(await closeOrphanedRuns(pool, []), 0, 'ohne eigene Projekte keine Abfrage');
});

test('Hängende Aufträge (In Arbeit ohne laufenden Lauf) werden je Projekt und beim Start blockiert', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return { rows: [], rowCount: 2 };
    },
  } as unknown as Pool;
  assert.equal(await recoverStuckItems(pool, 'mainty'), 2);
  await recoverStuckItems(pool, null);
  const [project, all] = queries;
  assert.match(project?.sql ?? '', /d\.status = 'in_progress'/);
  assert.match(
    project?.sql ?? '',
    /NOT EXISTS \(SELECT 1 FROM agent_runs r WHERE r\.development_id = d\.id AND r\.status = 'running'\)/,
  );
  // Nur Aufträge mit Läufen: Express-Aufträge aus dem Chat sind ohne Lauf „In Arbeit“.
  assert.match(project?.sql ?? '', /AND EXISTS \(SELECT 1 FROM agent_runs r WHERE r\.development_id = d\.id\)/);
  assert.equal(project?.values[0], 'mainty');
  assert.equal(all?.values[0], null);
});

test('Tester-Schritt speichert Tokens und Kosten des LLM-Laufs (Testschreiben + Testlauf)', async () => {
  process.env.DEV_LOG_AGENT_COMMAND = '["fake-agent"]';
  const { pool, queries } = fakePool();
  const execute: CommandExecutor = async () => ({
    exitCode: 0,
    durationMs: 1,
    output: 'Tests geschrieben',
    tokens: 1200,
    costUsd: 0.5,
  });
  const builtin: BuiltinAgent = async () => ({ exitCode: 0, durationMs: 1, output: 'grün', tokens: 30, costUsd: 0.25 });
  const tester = { ...agent('Tester', 'after_task', 1, null), role: 'tester' as const };
  try {
    assert.equal(await runWorkItem(pool, item, [tester], { cwd: '/r', timeoutMs: 1, execute, builtin }), 'passed');
  } finally {
    delete process.env.DEV_LOG_AGENT_COMMAND;
  }
  const saved = queries.find((query) => query.sql.includes('cost_usd = $7'));
  assert.ok(saved, 'Ergebnis wird gespeichert');
  assert.equal(saved.values[5], 1230);
  assert.equal(saved.values[6], 0.75);
});

test('Tester mit eigenem CLI: Tokens und Kosten des CLI-Laufs bleiben beim Speichern erhalten', async () => {
  const { pool, queries } = fakePool();
  // Ein Tester mit eigenem CLI muss die Abnahme melden, sonst gilt der Schritt als nicht bestanden.
  const output = `geprüft\n@@ACCEPTANCE {"criteria":[],"done":${JSON.stringify([1, 2, 3, 4, 5].map((nr) => ({ nr, met: true })))}}`;
  const execute: CommandExecutor = async (_command, _cwd, options) => {
    // result-Ereignis ohne Kosten und Tokens: die Werte des CLI-Laufs selbst müssen bleiben.
    options?.onChunk?.(JSON.stringify({ type: 'result', result: output }));
    return { exitCode: 0, durationMs: 1, output, tokens: 800, costUsd: 0.4 };
  };
  const builtin: BuiltinAgent = async () => ({ exitCode: 0, durationMs: 1, output: 'grün' });
  const tester = { ...agent('Tester', 'after_task', 1, ['claude', '-p']), role: 'tester' as const };
  assert.equal(await runWorkItem(pool, item, [tester], { cwd: '/r', timeoutMs: 1, execute, builtin }), 'passed');
  const saved = queries.find((query) => query.sql.includes('cost_usd = $7'));
  assert.ok(saved);
  assert.equal(saved.values[5], 800);
  assert.equal(saved.values[6], 0.4);
});

test('Nutzungslimit des Agent-Kontos: Auftrag bleibt geplant mit Startzeit nach dem Reset, kein Bug', async () => {
  const { pool, queries } = fakePool();
  const execute: CommandExecutor = async (command) => ({
    exitCode: command[0] === 'b' ? 1 : 0,
    durationMs: 1,
    output: command[0] === 'b' ? "You've hit your session limit · resets 12:40am (Europe/Zurich)" : '',
  });
  const agents = [agent('a', 'pre_task', 1, ['a']), agent('b', 'while_task', 1, ['b'])];
  const result = await runWorkItem(pool, item, agents, { cwd: '/repo', timeoutMs: 1000, execute });
  assert.equal(result, 'failed');
  const settled = queries.filter((query) => query.sql.includes('UPDATE development_items')).at(-1);
  assert.match(settled?.sql ?? '', /'planned'/);
  assert.doesNotMatch(settled?.sql ?? '', /'blocked'/);
  const retry = queries.find((query) => query.sql.includes('SET retry_after = $2'));
  assert.ok(retry?.values[1] instanceof Date, 'Startzeit nach dem Reset gespeichert');
  assert.match(String(retry?.values[2]), /Nutzungslimit .* ab \d\d:\d\d Uhr/);
  assert.ok(!queries.some((query) => query.sql.includes('INSERT INTO bugs')), 'kein Bug-Bericht');
  // Der Schritt ist als unterbrochen gekennzeichnet; Tokens und Kosten des Versuchs bleiben erhalten.
  const step = queries.find((query) => marksStepInterrupted(query.sql));
  assert.ok(step, 'Schritt als unterbrochen markiert');
  assert.match(step.sql, /tokens = \$5, cost_usd = \$6/);
});

test('Drain beim Neustart: nach dem laufenden Auftrag startet kein weiterer; danach geht es normal weiter', async () => {
  const { setDraining } = await import('../core/shutdown.js');
  const started: string[] = [];
  const items = [
    { ...item, id: 'a' },
    { ...item, id: 'b' },
  ];
  try {
    const results = await runSelectedItems(items, async (current) => {
      started.push(current.id);
      // Während Auftrag a läuft, wird ein Neustart angefordert.
      setDraining(true);
      return 'passed';
    });
    assert.deepEqual(started, ['a']);
    assert.deepEqual(results, [{ itemId: 'a', result: 'passed' }]);
  } finally {
    setDraining(false);
  }
  assert.equal((await runSelectedItems(items, async () => 'passed')).length, 2);
});

// Sprint abgebrochen, während der Auftrag lief: Er darf nicht mehr in den Sprint-Branch gemergt und nicht „erledigt“
// werden (der Sprint wird nie mehr gesichert), sondern geht zurück ins Backlog.
test('Sprint während des Laufs abgebrochen: nächster Agent startet nicht, Auftrag ins Backlog statt erledigt', async () => {
  let removed = false;
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('INSERT INTO agent_runs')) return { rows: [{ id: `run-${queries.length}` }] };
      if (sql.includes('paused_at IS NOT NULL AS paused')) return { rows: [{ paused: false }] };
      if (sql.includes('SELECT sprint_id AS "sprintId"')) return { rows: [{ sprintId: removed ? null : 'sprint-1' }] };
      if (sql.includes('FROM agent_runs WHERE development_id')) return { rows: [] };
      if (sql.includes('FROM agent_run_steps WHERE run_id')) return { rows: [] };
      return { rows: [{ id: 'step-row' }], rowCount: 1 };
    },
  } as unknown as Pool;
  const calls: string[] = [];
  const execute: CommandExecutor = async (command) => {
    calls.push(command[0] ?? '');
    if (command[0] === 'dev') removed = true;
    return { exitCode: 0, durationMs: 1, output: 'erledigt' };
  };
  const agents = [agent('dev', 'while_task', 1, ['dev']), agent('tester', 'after_task', 1, ['tester'])];
  assert.equal(
    await runWorkItem(pool, { ...item, sprintId: 'sprint-1' }, agents, { cwd: '/r', timeoutMs: 1, execute }),
    'failed',
  );
  assert.deepEqual(calls, ['dev']);
  assert.ok(
    queries.some((query) => /SET status = 'backlog'/.test(query.sql)),
    'zurück ins Backlog',
  );
  assert.ok(!queries.some((query) => query.values.includes('done')), 'nicht erledigt');
});
