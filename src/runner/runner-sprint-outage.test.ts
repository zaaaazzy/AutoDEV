import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import type { CommandExecutor } from '../core/command.js';
import { DEVELOPMENT_STATUS } from '../core/status.js';
import { runWorkItem, type WorkflowAgent } from './runner.js';

const item = { id: 'item-1', projectSlug: 'mainty', title: 'Sprints', description: 'Bauen', sprintId: 'sprint-1' };
const agent: WorkflowAgent = {
  id: 'dev-id',
  name: 'Entwickler',
  role: 'developer',
  phase: 'while_task',
  position: 1,
  instructions: 'baut',
  command: ['dev'],
};

test('Datenbank beim Lesen des Sprints weg: kein Branch von main, Auftrag bleibt geplant statt blockiert', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('INSERT INTO agent_runs')) return { rows: [{ id: 'run-1' }] };
      if (sql.includes('WITH fixed AS')) {
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5433'), { code: 'ECONNREFUSED' });
      }
      return { rows: [{ id: 'step-row' }], rowCount: 1 };
    },
  } as unknown as Pool;
  const commands: string[][] = [];
  const execute: CommandExecutor = async (command) => {
    commands.push(command);
    return { exitCode: 0, durationMs: 1, output: '' };
  };
  const result = await runWorkItem(pool, item, [agent], { cwd: '/repo', timeoutMs: 60_000, execute });
  assert.equal(result, 'failed');
  // Weder git (Branch von main) noch der Agent sind gelaufen.
  assert.deepEqual(commands, []);
  const updates = queries.filter((query) => query.sql.startsWith('UPDATE development_items'));
  assert.ok(
    updates.some((query) => query.sql.includes(`status = '${DEVELOPMENT_STATUS.planned}'`)),
    'unterbrochen: zurück auf „Geplant“',
  );
  assert.ok(
    !updates.some((query) => query.sql.includes(`status = '${DEVELOPMENT_STATUS.blocked}'`)),
    'ein Datenbankausfall blockiert den Auftrag nicht',
  );
});
