import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import type { CommandExecutor } from '../core/command.js';
import {
  budgetGate,
  claimRun,
  findResumableSession,
  resumePrompt,
  type RunContext,
  runStep,
  selectWorkflowAgents,
  stepModel,
} from './runner-steps.js';
import { shouldRetry } from './step-invocation.js';
import { ABANDONED_RUN_MS, MAX_STEP_MS } from './runner-runs.js';
import { loadWorkflow, MAX_TIMEOUT_MINUTES, type WorkflowRow } from './runner-selection.js';
import type { WorkflowAgent, WorkItem } from './runner-types.js';

// Charakterisierung von runner-steps.ts: hält das Verhalten vor der Aufteilung fest.

const item: WorkItem = { id: 'item-1', projectSlug: 'mainty', title: 'Sprints', description: 'Bauen' };

const agent = (name: string, overrides: Partial<WorkflowAgent> = {}): WorkflowAgent => ({
  id: `${name}-id`,
  name,
  role: 'custom',
  phase: 'while_task',
  position: 1,
  instructions: `${name} macht etwas`,
  command: null,
  ...overrides,
});

interface Query {
  sql: string;
  values: unknown[];
}

function fakePool(answer: (sql: string, values: unknown[]) => unknown[] | undefined = () => undefined) {
  const queries: Query[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return { rows: answer(sql, values) ?? [], rowCount: 1 };
    },
  } as unknown as Pool;
  return { pool, queries };
}

function context(pool: Pool, execute: CommandExecutor, overrides: Partial<RunContext> = {}): RunContext {
  return {
    pool,
    item,
    runId: 'run-1',
    options: { cwd: '/nicht/vorhanden', timeoutMs: 1_000, execute, transientRetryDelayMs: 0 },
    execute,
    builtin: async () => ({ exitCode: 0, durationMs: 0, output: 'eingebaut' }),
    done: [],
    bugs: [],
    images: [],
    fallbackCommand: null,
    projectContext: '',
    ...overrides,
  };
}

test('selectWorkflowAgents: nur Auftragsphasen, nach Phase und Position sortiert', () => {
  const agents = [
    agent('Review', { phase: 'after_task', position: 1 }),
    agent('Dev', { phase: 'while_task', position: 2 }),
    agent('Autor', { phase: 'pre_task', position: 1, role: 'author' }),
    agent('Test', { phase: 'while_task', position: 1 }),
    agent('Sprint', { phase: 'pre_sprint', position: 0 }),
  ];
  assert.deepEqual(
    selectWorkflowAgents(agents, item).map((entry) => entry.name),
    ['Autor', 'Test', 'Dev', 'Review'],
  );
});

test('selectWorkflowAgents: überspringt Autor bei Idee, Bug-Wächter bei Risiken und visuelle Prüfung im Backend', () => {
  const agents = [
    agent('Autor', { phase: 'pre_task', role: 'author' }),
    agent('Wächter', { phase: 'pre_task', role: 'bug_reviewer' }),
    agent('Visuell', { phase: 'after_task', role: 'visual_tester' }),
  ];
  const names = (work: WorkItem): string[] => selectWorkflowAgents(agents, work).map((entry) => entry.name);
  assert.deepEqual(names(item), ['Autor', 'Wächter']);
  assert.deepEqual(names({ ...item, ideationId: 'idee', risks: ' Risiko ', category: 'frontend' }), ['Visuell']);
  assert.deepEqual(names({ ...item, risks: '  ', category: 'backend' }), ['Autor', 'Wächter']);
  // Ein einzeln gestarteter Agent läuft allein, auch wenn er sonst übersprungen würde.
  assert.deepEqual(names({ ...item, agentId: 'Visuell-id' }), ['Visuell']);
});

// Ablauf nach den Einstellungen: loadWorkflow (Schritte bzw. Agent-Felder) → selectWorkflowAgents → Ausführung.
const row = (name: string, overrides: Partial<WorkflowRow> = {}): WorkflowRow => ({
  ...agent(name),
  enabled: true,
  ...overrides,
});

async function executedOrder(steps: WorkflowRow[], agents: WorkflowRow[]): Promise<string[]> {
  const { pool } = fakePool((sql) => (sql.includes('FROM workflow_steps s') ? steps : agents));
  return selectWorkflowAgents(await loadWorkflow(pool, 'mainty'), item).map((entry) => entry.name);
}

test('loadWorkflow: geänderte Reihenfolge der Schritte wird so ausgeführt, Agent-Position zählt nicht', async () => {
  const steps = [
    row('Dev', { phase: 'while_task', position: 2, stepId: 's1' }),
    row('Test', { phase: 'while_task', position: 1, stepId: 's2' }),
  ];
  assert.deepEqual(await executedOrder(steps, [row('Dev', { position: 1 }), row('Test', { position: 2 })]), [
    'Test',
    'Dev',
  ]);
});

test('loadWorkflow: pausierter Schritt läuft nicht, die übrigen Schritte desselben Agents schon', async () => {
  const steps = [
    row('Dev', { position: 1, stepId: 's1', enabled: false }),
    row('Review', { phase: 'after_task', position: 1, stepId: 's2' }),
    row('Dev', { phase: 'after_task', position: 2, stepId: 's3', stepInstructions: 'Nachbessern' }),
  ];
  assert.deepEqual(await executedOrder(steps, []), ['Review', 'Dev']);
});

test('loadWorkflow: deaktivierter Agent läuft in keinem seiner Schritte (auch ohne Schritte nicht)', async () => {
  const steps = [row('Dev', { stepId: 's1', agentEnabled: false }), row('Test', { position: 2, stepId: 's2' })];
  assert.deepEqual(await executedOrder(steps, []), ['Test']);
  assert.deepEqual(await executedOrder([], [row('Dev', { enabled: false }), row('Test', { position: 2 })]), ['Test']);
});

test('loadWorkflow: Schritt nach Phasenwechsel läuft in der neuen Phase', async () => {
  const steps = [
    row('Autor', { phase: 'pre_task', position: 1, stepId: 's1' }),
    row('Dev', { phase: 'while_task', position: 1, stepId: 's2' }),
    // Am Agent steht noch while_task; der Schritt ist nach after_task gewechselt.
    row('Doku', { phase: 'after_task', position: 1, stepId: 's3' }),
  ];
  assert.deepEqual(await executedOrder(steps, [row('Doku', { phase: 'while_task', position: 0 })]), [
    'Autor',
    'Dev',
    'Doku',
  ]);
});

test('loadWorkflow: ohne Workflow-Schritte gelten Phase und Position der Agents', async () => {
  const agents = [
    row('Review', { phase: 'after_task', position: 1 }),
    row('Dev', { phase: 'while_task', position: 2 }),
    row('Test', { phase: 'while_task', position: 1 }),
  ];
  assert.deepEqual(await executedOrder([], agents), ['Test', 'Dev', 'Review']);
});

test('resumePrompt: Fortsetzung nennt den Grund und hängt den aktuellen Auftrag an', () => {
  const fixed = resumePrompt('AUFTRAG', { sessionId: 's', passed: true });
  assert.match(fixed, /^## Fortsetzung deiner früheren Sitzung/);
  assert.match(fixed, /Rückmeldungen, die du nachbessern sollst/);
  assert.ok(fixed.endsWith('\n\nAUFTRAG'));
  assert.match(resumePrompt('AUFTRAG', { sessionId: 's', passed: false }), /unterbrochen oder abgebrochen/);
});

test('stepModel: Routing vor eigenem Befehl vor Standardbefehl, Tester und eingebautes Modell', () => {
  const { pool } = fakePool();
  const ctx = context(pool, async () => ({ exitCode: 0, durationMs: 0, output: '' }), {
    fallbackCommand: ['claude', '-p', '--model', 'sonnet'],
  });
  const dev = agent('Dev', { role: 'developer' });
  assert.equal(stepModel(ctx, dev, { model: 'qwen3.5:9b', rule: 'docs' }), 'qwen3.5:9b');
  assert.equal(stepModel(ctx, dev, { command: ['claude', '--model=opus'], rule: 'groß' }), 'claude (opus)');
  assert.equal(stepModel(ctx, { ...dev, command: ['/usr/bin/codex'] }, { rule: null }), 'codex');
  assert.equal(stepModel(ctx, dev, { rule: null }), 'claude (sonnet)');
  assert.equal(stepModel(ctx, agent('Test', { role: 'tester' }), { rule: null }), 'claude (sonnet) + Testlauf');
  assert.equal(
    stepModel({ ...ctx, fallbackCommand: null }, agent('Test', { role: 'tester' }), { rule: null }),
    'Testlauf',
  );
});

test('claimRun: räumt zuerst verwaiste Läufe des Auftrags ab und meldet null, wenn schon ein Lauf läuft', async () => {
  const free = fakePool((sql) => (sql.includes('INSERT INTO agent_runs') ? [{ id: 'run-9' }] : undefined));
  assert.equal(await claimRun(free.pool, item), 'run-9');
  assert.match(free.queries[0]?.sql ?? '', /UPDATE agent_runs r SET status = 'failed'/);
  assert.deepEqual(free.queries[0]?.values, [item.id, ABANDONED_RUN_MS]);
  // Absturz-Recovery: der hängende Schritt des verwaisten Laufs gilt als unterbrochen, nicht als Ablehnung.
  assert.match(
    free.queries[0]?.sql ?? '',
    /UPDATE agent_run_steps SET status = 'failed', interrupted = TRUE[\s\S]*WHERE status = 'running' AND run_id IN \(SELECT id FROM abandoned\)/,
  );
  assert.match(free.queries[1]?.sql ?? '', /ON CONFLICT \(development_id\) WHERE status = 'running' DO NOTHING/);
  // Ohne Worker-ID (Tests, Werkzeuge) bleibt sie leer; der Worker setzt sie beim Start (setWorkerId).
  assert.deepEqual(free.queries[1]?.values, [item.projectSlug, item.id, null]);

  // Nebenläufigkeit: Ein zweiter Worker bekommt den Auftrag nicht, solange der erste Lauf läuft.
  const busy = fakePool();
  assert.equal(await claimRun(busy.pool, item), null);
});

test('findResumableSession: liefert die letzte Sitzung desselben Einsatzes', async () => {
  const { pool, queries } = fakePool((sql) =>
    sql.includes('session_id AS "sessionId"') ? [{ sessionId: 'sess-1', status: 'passed' }] : undefined,
  );
  assert.deepEqual(await findResumableSession(pool, item.id, { id: 'a', stepId: 'step-a' }, '7'), {
    sessionId: 'sess-1',
    passed: true,
  });
  assert.deepEqual(queries[0]?.values, [item.id, '7', 'step-a']);
  const none = fakePool();
  assert.equal(await findResumableSession(none.pool, item.id, { id: 'a' }, undefined), null);
  assert.deepEqual(none.queries[0]?.values, [item.id, null, 'a']);
});

test('budgetGate: ohne Budget kein Halt, der Anteil wird am Kontext gemerkt', async () => {
  const { pool } = fakePool();
  const ctx = context(pool, async () => ({ exitCode: 0, durationMs: 0, output: '' }), { budgetPercent: 55 });
  assert.equal(await budgetGate(ctx), null);
  assert.equal(ctx.budgetPercent, 0);
});

test('runStep: erfolgreicher Schritt wird gespeichert und an die Nachfolger weitergegeben', async () => {
  const { pool, queries } = fakePool((sql) =>
    sql.includes('INSERT INTO agent_run_steps') ? [{ id: 'step-1' }] : undefined,
  );
  const calls: string[][] = [];
  const execute: CommandExecutor = async (command) => {
    calls.push(command);
    return { exitCode: 0, durationMs: 5, output: 'fertig', tokens: 10, costUsd: 0.5 };
  };
  const ctx = context(pool, execute);
  const outcome = await runStep(ctx, agent('Dev', { command: ['dev'] }), 0, 1);
  assert.deepEqual(outcome, { passed: true, interrupted: false, correctable: false, cancelled: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], 'dev');
  const saved = queries.find((query) => query.sql.includes('SET status = $2, exit_code = $3'));
  assert.deepEqual(saved?.values.slice(0, 7), ['step-1', 'passed', 0, 5, 'fertig', 10, 0.5]);
  assert.deepEqual(ctx.done, [{ agentName: 'Dev', phase: 'while_task', status: 'passed', output: 'fertig' }]);
  assert.ok(!queries.some((query) => query.sql.includes('INSERT INTO bugs')));
});

test('runStep: ein Fehlschlag mit canCorrect geht zurück an den Entwickler, ohne Bug-Bericht', async () => {
  const { pool, queries } = fakePool((sql) =>
    sql.includes('INSERT INTO agent_run_steps') ? [{ id: 'step-1' }] : undefined,
  );
  const execute: CommandExecutor = async () => ({ exitCode: 1, durationMs: 1, output: 'Test rot' });
  const outcome = await runStep(context(pool, execute), agent('Test', { command: ['test'] }), 1, 2, {
    canCorrect: true,
  });
  assert.deepEqual(outcome, { passed: false, interrupted: false, correctable: true, cancelled: false });
  assert.ok(!queries.some((query) => query.sql.includes('INSERT INTO bugs')));
});

test('runStep: Abbruch aus der Oberfläche beendet den Schritt sofort, ohne Bug und ohne Wiederholung', async () => {
  const { pool, queries } = fakePool((sql) => {
    if (sql.includes('INSERT INTO agent_run_steps')) return [{ id: 'step-1' }];
    if (sql.includes('SELECT cancel_requested')) return [{ cancel_requested: true }];
    return undefined;
  });
  let calls = 0;
  let agentEnded = false;
  // Der Agent endet erst über das Abbruch-Signal (wie runCommand); ohne Signal liefe er bis zum Zeitlimit.
  const execute: CommandExecutor = (_command, _cwd, options = {}) => {
    calls += 1;
    return new Promise((resolveRun) => {
      options.signal?.addEventListener('abort', () =>
        setTimeout(() => {
          agentEnded = true;
          resolveRun({ exitCode: 1, durationMs: 0, output: 'Ollama nicht erreichbar' });
        }, 200),
      );
    });
  };
  const ctx = context(pool, execute);
  const startedAt = Date.now();
  const outcome = await runStep(ctx, agent('Dev', { command: ['dev'] }), 0, 1);
  assert.ok(Date.now() - startedAt < 10_000, 'Abbruch erreicht den Agent über das Signal');
  // Commit und checkout base dürfen erst laufen, wenn der Agent wirklich beendet ist.
  assert.equal(agentEnded, true, 'wartet auf das echte Ende des Agents');
  // Der Abbruch wird gemeldet: runWorkItem startet danach keinen Agent mehr (auch nicht „Bei abgelehnt“).
  assert.deepEqual(outcome, { passed: false, interrupted: false, correctable: false, cancelled: true });
  assert.equal(calls, 1, 'ein Abbruch wird nicht als vorübergehender Fehler wiederholt');
  const saved = queries.find((query) => query.sql.includes('SET status = $2, exit_code = $3'));
  assert.deepEqual(saved?.values.slice(1, 3), ['failed', 130]);
  assert.match(String(saved?.values[4]), /Vom Benutzer abgebrochen/);
  assert.ok(!queries.some((query) => query.sql.includes('INSERT INTO bugs')));
});

// Verhaltensänderungen: Retry nur bei Agent-Fehlern und mit Budget, Schwelle für verwaiste Läufe.

test('verwaiste Läufe: Schwelle liegt über der längsten Schrittlaufzeit samt Wiederholung', async () => {
  assert.ok(MAX_STEP_MS >= 2 * MAX_TIMEOUT_MINUTES * 60_000);
  assert.ok(ABANDONED_RUN_MS > MAX_STEP_MS);
  // Lebenszeichen ist der letzte Eintrag im Verlauf eines Schritts, nicht nur der Start des Laufs.
  const { pool, queries } = fakePool();
  await claimRun(pool, item);
  assert.match(queries[0]?.sql ?? '', /GREATEST\(\s*r\.started_at,[\s\S]*jsonb_array_elements\(s\.events\)/);
});

test('shouldRetry: nur Agent-Fehler, nie das Ergebnis der Projekttests', () => {
  assert.equal(shouldRetry({ exitCode: 1, durationMs: 0, output: 'Ollama nicht erreichbar' }), true);
  assert.equal(shouldRetry({ exitCode: 1, durationMs: 0, output: 'API Error: 529 overloaded' }), true);
  assert.equal(shouldRetry({ exitCode: 0, durationMs: 0, output: 'Ollama nicht erreichbar' }), false);
  assert.equal(shouldRetry({ exitCode: 1, durationMs: 0, output: 'TypeError: x is undefined' }), false);
  assert.equal(
    shouldRetry({ exitCode: 1, durationMs: 0, output: 'connect ECONNREFUSED 127.0.0.1:5432', fromTests: true }),
    false,
  );
});

test('runStep: rote Projekttests mit ECONNREFUSED werden nicht wiederholt', async () => {
  const { pool, queries } = fakePool((sql) =>
    sql.includes('INSERT INTO agent_run_steps') ? [{ id: 'step-1' }] : undefined,
  );
  let runs = 0;
  const execute: CommandExecutor = async () => ({ exitCode: 0, durationMs: 0, output: '' });
  const ctx = context(pool, execute, {
    builtin: async () => {
      runs += 1;
      return { exitCode: 1, durationMs: 1, output: '$ npm test → failed\nError: connect ECONNREFUSED 127.0.0.1:5432' };
    },
  });
  const outcome = await runStep(ctx, agent('Test', { role: 'tester' }), 0, 1);
  assert.equal(outcome.passed, false);
  assert.equal(runs, 1, 'kein zweiter Testlauf');
  assert.ok(!queries.some((query) => JSON.stringify(query.values).includes('Vorübergehender Fehler')));
});

test('runStep: vor dem neuen Versuch wird das Budget geprüft – erreicht, hält der Lauf ohne Bug an', async () => {
  const { pool, queries } = fakePool((sql) => {
    if (sql.includes('INSERT INTO agent_run_steps')) return [{ id: 'step-1' }];
    if (sql.includes('FROM budgets')) return [{ period: 'order', maxTokens: '1000', maxCostUsd: null }];
    if (sql.includes('SUM(s.tokens)')) return [{ tokens: '1500', cost: '0', since: null }];
    return undefined;
  });
  let calls = 0;
  const execute: CommandExecutor = async () => {
    calls += 1;
    return { exitCode: 1, durationMs: 1, output: 'Fehler: Ollama nicht erreichbar', tokens: 1500 };
  };
  const outcome = await runStep(context(pool, execute), agent('Dev', { command: ['dev'] }), 0, 1);
  assert.equal(calls, 1, 'kein zweiter Versuch über dem Budget');
  assert.equal(outcome.passed, false);
  assert.equal(outcome.budget?.period, 'order');
  assert.ok(!queries.some((query) => query.sql.includes('INSERT INTO bugs')));
  assert.ok(
    queries.some((query) => JSON.stringify(query.values).includes('kein neuer Versuch, das Budget ist erreicht')),
  );

  // Mit Budget wird wie bisher einmal wiederholt.
  const free = fakePool((sql) => (sql.includes('INSERT INTO agent_run_steps') ? [{ id: 'step-1' }] : undefined));
  let freeCalls = 0;
  const flaky: CommandExecutor = async () => {
    freeCalls += 1;
    return freeCalls === 1
      ? { exitCode: 1, durationMs: 1, output: 'Fehler: Ollama nicht erreichbar' }
      : { exitCode: 0, durationMs: 1, output: 'fertig' };
  };
  const retried = await runStep(context(free.pool, flaky), agent('Dev', { command: ['dev'] }), 0, 1);
  assert.equal(freeCalls, 2);
  assert.equal(retried.passed, true);
});
