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
  let agentEnded = false;
  // Der Agent hängt bis zum Abbruch-Signal (wie runCommand, das dann die Prozessgruppe beendet) und braucht danach
  // noch etwas, bis er wirklich fertig ist.
  const execute: CommandExecutor = (_command, _cwd, options = {}) =>
    new Promise((resolve) => {
      started = true;
      options.signal?.addEventListener('abort', () =>
        setTimeout(() => {
          agentEnded = true;
          resolve({ exitCode: 1, durationMs: 1, output: 'beendet', tokens: 42, costUsd: 0.5 });
        }, 300),
      );
    });
  const running = runWorkItem(pool, item, [agent], { cwd: '/repo', timeoutMs: 600_000, execute });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(started, true);
  cancel = true;
  const result = await Promise.race([running, new Promise((resolve) => setTimeout(() => resolve('hängt'), 6000))]);
  assert.equal(result, 'failed');
  // Git-Schritte und Abschluss erst, wenn der Agent wirklich beendet ist – nicht schon beim Abbruch-Signal.
  assert.equal(agentEnded, true);
  assert.ok(queries.some((query) => query.values.some((value) => String(value).includes('Vom Benutzer abgebrochen'))));
  assert.ok(queries.some((query) => query.values.some((value) => String(value).includes('warte, bis der Agent'))));
});
