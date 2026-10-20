import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import type { CommandExecutor } from '../core/command.js';
import { PRE_SPRINT_ATTEMPTS, runPreSprint } from './pre-sprint.js';
import type { WorkflowAgent } from './runner-types.js';

const planner: WorkflowAgent = {
  id: 'plan-id',
  name: 'Planer',
  role: 'custom',
  phase: 'pre_sprint',
  position: 1,
  instructions: 'Prüfe den Sprint',
  command: ['plan'],
};
const options = { project: 'mainty', cwd: '/r', timeoutMs: 1000 };

/** Aktiver Sprint ohne Phase „Vor dem Sprint“; optional ein erreichtes Tagesbudget. */
function fakePool(sprintId: string, budgetExceeded = () => false) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('pre_sprint_at IS NULL')) return { rows: [{ id: sprintId, name: 'Sprint 1', goal: null }] };
      if (sql.includes('FROM agents WHERE project_slug = $1 AND id = $2'))
        return { rows: [{ instructions: 'Prüfe', command: ['plan'], allowedCommands: null, fileScope: null }] };
      if (sql.includes('FROM budgets'))
        return { rows: budgetExceeded() ? [{ period: 'day', maxTokens: '1000', maxCostUsd: null }] : [] };
      if (sql.includes('to_char(CURRENT_DATE')) return { rows: [{ key: '2026-10-20', since: '2026-10-20' }] };
      if (sql.includes('FROM agent_run_steps s JOIN agent_runs r')) return { rows: [{ tokens: '1500', cost: '0' }] };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const finished = () => queries.filter((query) => query.sql.includes('SET pre_sprint_at = NOW()'));
  return { pool, queries, finished };
}

test('Vor dem Sprint gescheitert: die Phase wird im nächsten Zyklus wiederholt, Fehlertext nie als Sprint-Hinweis', async () => {
  const { pool, finished } = fakePool('sprint-retry');
  let calls = 0;
  const failing: CommandExecutor = async () => {
    calls += 1;
    return { exitCode: 1, durationMs: 1, output: 'Fehler: Ollama nicht erreichbar' };
  };
  for (let attempt = 1; attempt < PRE_SPRINT_ATTEMPTS; attempt += 1) {
    assert.equal(await runPreSprint(pool, options, [planner], failing), true);
    assert.equal(finished().length, 0, `Versuch ${attempt}: Phase gilt nicht als erledigt`);
  }
  // Letzter Versuch: die Aufträge starten ohne die Phase, ohne die Fehlermeldung als Hinweis.
  assert.equal(await runPreSprint(pool, options, [planner], failing), true);
  assert.equal(calls, PRE_SPRINT_ATTEMPTS);
  assert.equal(finished().length, 1);
  assert.equal(finished()[0]?.values[1], null);
});

test('Vor dem Sprint erfolgreich: Ergebnis wird Sprint-Hinweis', async () => {
  const { pool, finished } = fakePool('sprint-ok');
  const ok: CommandExecutor = async () => ({ exitCode: 0, durationMs: 1, output: 'Reihenfolge passt.' });
  assert.equal(await runPreSprint(pool, options, [planner], ok), true);
  assert.match(String(finished()[0]?.values[1]), /### Planer\nReihenfolge passt\./);
});

test('Vor dem Sprint bei erreichtem Budget: nichts läuft, die Phase wird später nachgeholt', async () => {
  const { pool, finished } = fakePool('sprint-budget', () => true);
  let calls = 0;
  const execute: CommandExecutor = async () => {
    calls += 1;
    return { exitCode: 0, durationMs: 1, output: '' };
  };
  assert.equal(await runPreSprint(pool, options, [planner], execute), false);
  assert.equal(calls, 0);
  assert.equal(finished().length, 0);
});
