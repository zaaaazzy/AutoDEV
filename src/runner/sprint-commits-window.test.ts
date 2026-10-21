import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { syncSprintCommits } from './sprint-commits.js';

test('Stände: aktive Sprints zuerst, geplante gar nicht – vorab angelegte Sprints verdrängen den aktiven nicht', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  await syncSprintCommits(pool, 'dev-log', '/tmp', async () => ({ exitCode: 1, output: '' }) as never);
  const select = queries.find((query) => query.sql.includes('FROM sprints'));
  assert.ok(select);
  assert.match(select.sql, /status <> 'planned'/);
  assert.match(select.sql, /ORDER BY \(status IN \('active', 'review'\)\) DESC, created_at DESC/);
  assert.deepEqual(select.values, ['dev-log']);
});
