import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import type { CommandExecutor } from '../core/command.js';
import { runWorkItem, type WorkflowAgent } from './runner.js';

const item = { id: 'item-1', projectSlug: 'mainty', title: 'Sprints', description: 'Bauen' };
const agent: WorkflowAgent = {
  id: 'dev-id',
  name: 'Entwickler',
  role: 'custom',
  phase: 'while_task',
  position: 1,
  instructions: 'baut',
  command: ['dev'],
};

test('Abbrechen beendet einen hängenden Agent-Schritt sofort', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  let cancel = false;
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('INSERT INTO agent_runs')) return { rows: [{ id: 'run-1' }] };
      if (sql.includes('SELECT cancel_requested')) return { rows: [{ cancel_requested: cancel }] };
      return { rows: [{ id: 'step-row' }] };
    },
  } as unknown as Pool;
  let started = false;
  const execute: CommandExecutor = (_command, options) =>
    new Promise((resolve) => {
      started = true;
      options?.signal?.addEventListener('abort', () => resolve({ exitCode: 143, durationMs: 1, output: 'killed' }));
    });
  const running = runWorkItem(pool, item, [agent], { cwd: '/repo', timeoutMs: 600_000, execute });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(started, true);
  cancel = true;
  const result = await Promise.race([running, new Promise((resolve) => setTimeout(() => resolve('hängt'), 6000))]);
  assert.equal(result, 'failed');
  assert.ok(queries.some((query) => query.values.some((value) => String(value).includes('Vom Benutzer abgebrochen'))));
});
