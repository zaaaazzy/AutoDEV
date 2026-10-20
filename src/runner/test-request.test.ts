import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Pool } from 'pg';
import type { CommandExecutor } from '../core/command.js';
import { processTestRequest } from './test-request.js';

test('Testanfrage: run_id ist vor den Befehlen gesetzt, bei Fehler wird der Lauf beendet', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'test-request-'));
  const queries: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes("SET status = 'running'")) return { rows: [{ id: 'req-1', scope: 'full' }] };
      if (sql.includes('test_commands')) return { rows: [{ commands: [['npm', 'test']] }] };
      return { rows: [] };
    },
  } as unknown as Pool;
  const execute: CommandExecutor = async () => ({ exitCode: 1, durationMs: 0, output: '' });
  let linkedBeforeRun = false;
  try {
    const handled = await processTestRequest(pool, { project: 'demo', cwd }, execute, async (options) => {
      await options.onRunCreated?.('run-7');
      linkedBeforeRun = queries.some((q) => q.sql.includes('SET run_id') && q.params[1] === 'run-7');
      throw new Error('Worker abgestürzt');
    });
    assert.equal(handled, true);
    assert.equal(linkedBeforeRun, true);
    assert.ok(queries.some((q) => q.sql.includes('UPDATE test_runs') && q.params[0] === 'req-1'));
    assert.ok(queries.some((q) => q.sql.includes("status = 'failed'") && q.params[1] === 'Worker abgestürzt'));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
