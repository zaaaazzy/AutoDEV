import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { DEFAULT_ACTIONS, seedDefaultActions } from './agent-tasks.js';

function fakePool(options: { seeded: boolean; tester: boolean }) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('FROM app_settings')) return { rows: options.seeded ? [{}] : [] };
      if (sql.includes("role = 'tester'")) return { rows: options.tester ? [{ id: 'tester-1' }] : [] };
      if (sql.includes('INSERT INTO agent_tasks')) return { rows: [], rowCount: DEFAULT_ACTIONS.length };
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  return { pool, queries };
}

test('Standard-Aktionen: einmalig, dem Tester zugewiesen', async () => {
  const { pool, queries } = fakePool({ seeded: false, tester: true });
  assert.equal(await seedDefaultActions(pool, 'mainty'), DEFAULT_ACTIONS.length);
  const insert = queries.find((query) => query.sql.includes('INSERT INTO agent_tasks'))!;
  assert.equal(insert.values[1], 'tester-1');
  assert.ok(queries.some((query) => query.sql.includes('INSERT INTO app_settings')));
});

test('Standard-Aktionen: nicht erneut und nicht ohne Tester', async () => {
  assert.equal(await seedDefaultActions(fakePool({ seeded: true, tester: true }).pool, 'mainty'), 0);
  const withoutTester = fakePool({ seeded: false, tester: false });
  assert.equal(await seedDefaultActions(withoutTester.pool, 'mainty'), 0);
  assert.ok(!withoutTester.queries.some((query) => query.sql.includes('INSERT INTO app_settings')));
});
