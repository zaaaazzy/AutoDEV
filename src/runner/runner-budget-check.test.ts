import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import type { CommandExecutor } from '../core/command.js';
import { BUDGET_CHECK_RETRY_MS, runWorkItem, type WorkflowAgent } from './runner.js';

// Scheitert die Budgetabfrage (Datenbank kurz weg), darf kein Agent ohne Prüfung starten: Der Auftrag gilt als
// unterbrochen, die Ursache steht am Auftrag und in einem Schritt, und er startet erst nach einer Pause wieder.

const agent = (name: string, phase: string, position: number, role = 'custom'): WorkflowAgent => ({
  id: `${name}-id`,
  name,
  role,
  phase,
  position,
  instructions: `${name} macht etwas`,
  command: [name],
});

type Query = { sql: string; values: unknown[] };

function fakePool(answer: (sql: string) => { rows: unknown[] } | null) {
  const queries: Query[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('INSERT INTO agent_runs')) return { rows: [{ id: 'run-1' }] };
      return answer(sql) ?? { rows: [{ id: 'step-row' }] };
    },
  } as unknown as Pool;
  return { pool, queries };
}

const recorded = (queries: Query[]) =>
  queries.filter((query) => query.sql.includes('WITH step AS') && query.sql.includes('retry_after = NOW()'));

const dbDown = () => Object.assign(new Error('Connection terminated unexpectedly'), { code: '57P01' });

test('Budgetprüfung wirft vor dem ersten Schritt: kein Agent startet, Auftrag unterbrochen statt ungebremst', async () => {
  const { pool, queries } = fakePool((sql) => {
    if (sql.includes('FROM budgets')) throw dbDown();
    return null;
  });
  const calls: string[] = [];
  const execute: CommandExecutor = async (command) => {
    calls.push(command[0] ?? '');
    return { exitCode: 0, durationMs: 1, output: 'fertig' };
  };
  const item = { id: 'item-1', projectSlug: 'mainty', title: 'Budget', description: 'Bauen' };
  const agents = [agent('dev', 'while_task', 1, 'developer'), agent('watcher', 'on_rejected', 2)];
  const result = await runWorkItem(pool, item, agents, { cwd: '/r', timeoutMs: 1, execute });

  assert.equal(result, 'failed');
  assert.deepEqual(calls, [], 'weder der Entwickler noch „Bei abgelehnt“ laufen ohne Budgetprüfung');
  const [record] = recorded(queries);
  assert.ok(record, 'Ursache am Auftrag und als eigener Schritt (eine Anweisung)');
  assert.match(String(record.values[1]), /Budget liess sich nicht prüfen \(Connection terminated unexpectedly\)/);
  assert.match(String(record.values[1]), /„dev“ startet nicht/);
  assert.equal(record.values[3], 0, 'Schritt an der Position des Agents, der nicht startete');
  assert.equal(record.values[4], 'dev-id');
  assert.equal(record.values[8], BUDGET_CHECK_RETRY_MS / 1000, 'erst nach einer Pause wieder (kein Sofort-Neustart)');
  assert.match(record.sql, /interrupted\)/);
  // Unterbrochen, nicht blockiert: zurück auf „Geplant“, keine Budget-Blockade, kein Bug-Bericht.
  assert.ok(queries.some((query) => query.sql.includes("SET status = 'planned'")));
  assert.ok(!queries.some((query) => query.sql.includes('budget_blocked = $3')));
  assert.ok(!queries.some((query) => query.sql.includes('INSERT INTO bugs')));
});

test('Sprintbudget nicht prüfbar (Verbrauch der Sprint-Aufträge): Sprint-Auftrag startet nicht', async () => {
  const { pool, queries } = fakePool((sql) => {
    if (sql.includes('FROM budgets')) return { rows: [{ period: 'sprint', maxTokens: '1000', maxCostUsd: null }] };
    if (sql.includes('FROM sprints') && sql.includes('AS since')) {
      return { rows: [{ id: '33333333-3333-4333-8333-333333333333', since: '2026-10-01 00:00:00+00' }] };
    }
    // Verbrauch nur der Läufe der Sprint-Aufträge seit Sprintbeginn: genau diese Abfrage scheitert.
    if (sql.includes('d.sprint_id = $2::uuid')) throw dbDown();
    return null;
  });
  const calls: string[] = [];
  const execute: CommandExecutor = async (command) => {
    calls.push(command[0] ?? '');
    return { exitCode: 0, durationMs: 1, output: 'fertig' };
  };
  const item = {
    id: 'item-2',
    projectSlug: 'mainty',
    title: 'Sprint-Auftrag',
    description: 'Bauen',
    sprintId: '33333333-3333-4333-8333-333333333333',
  };
  const result = await runWorkItem(pool, item, [agent('dev', 'while_task', 1, 'developer')], {
    cwd: '/r',
    timeoutMs: 1,
    execute,
  });
  assert.equal(result, 'failed');
  assert.deepEqual(calls, []);
  assert.ok(queries.some((query) => query.sql.includes('d.sprint_id = $2::uuid')), 'Sprintverbrauch wurde abgefragt');
  assert.equal(recorded(queries).length, 1);
  assert.ok(!queries.some((query) => query.sql.includes('budget_blocked = $3')));
});

test('vorübergehender Fehler und Budget vor dem zweiten Versuch nicht prüfbar: kein zweiter Versuch, unterbrochen', async () => {
  let executed = 0;
  const { pool, queries } = fakePool((sql) => {
    if (sql.includes('FROM budgets')) {
      if (executed) throw dbDown();
      return { rows: [] };
    }
    return null;
  });
  const execute: CommandExecutor = async () => {
    executed += 1;
    return { exitCode: 1, durationMs: 1, output: 'Fehler: Ollama nicht erreichbar', tokens: 40, costUsd: 0.2 };
  };
  const item = { id: 'item-3', projectSlug: 'mainty', title: 'Flaky', description: 'Bauen' };
  const result = await runWorkItem(pool, item, [agent('tester', 'after_task', 1, 'tester')], {
    cwd: '/r',
    timeoutMs: 1,
    execute,
    transientRetryDelayMs: 0,
  });
  assert.equal(result, 'failed');
  assert.equal(executed, 1, 'ohne Budgetprüfung kein zweiter Versuch');
  const marked = queries.find((query) => query.sql.includes('interrupted = TRUE WHERE id = $1'));
  assert.ok(marked, 'der laufende Schritt ist als unterbrochen markiert');
  assert.match(String(marked.values[3]), /Budget liess sich nicht prüfen/);
  assert.equal(marked.values[4], 40, 'Tokens des ersten Versuchs bleiben gezählt');
  const [record] = recorded(queries);
  assert.ok(record);
  assert.equal(record.values[3], null, 'kein zweiter Schritt neben dem laufenden');
  assert.ok(queries.some((query) => query.sql.includes("SET status = 'planned'")));
  assert.ok(!queries.some((query) => query.sql.includes('INSERT INTO bugs')));
});
