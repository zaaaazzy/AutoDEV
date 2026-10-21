import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { cancelAgent, ORPHAN_CANCEL_NOTE } from './agent-cancel.js';

function fakePool(requested: number, closed: number) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('SET cancel_requested = TRUE')) return { rowCount: requested, rows: [] };
      return { rowCount: 1, rows: [{ count: closed }] };
    },
  } as unknown as Pool;
  return { pool, queries };
}

test('Agent läuft nicht: nichts zu tun, kein Abschluss', async () => {
  const { pool, queries } = fakePool(0, 0);
  assert.deepEqual(await cancelAgent(pool, 'mainty', 'a-1'), { requested: 0, closed: 0 });
  assert.equal(queries.length, 1);
});

test('Worker läuft: nur markieren, der Worker bricht selbst ab', async () => {
  const { pool } = fakePool(1, 0);
  assert.deepEqual(await cancelAgent(pool, 'mainty', 'a-1'), { requested: 1, closed: 0 });
});

test('verwaister Schritt (Worker offline oder seither neu gestartet): Abbruch schließt Schritt, Lauf und Auftrag ab', async () => {
  const { pool, queries } = fakePool(1, 1);
  assert.deepEqual(await cancelAgent(pool, 'mainty', 'a-1'), { requested: 1, closed: 1 });
  const close = queries[1]!;
  assert.match(close.sql, /h\.last_seen IS NULL OR h\.last_seen < NOW\(\) - make_interval\(secs => \$3\)/);
  assert.match(close.sql, /h\.started_at > COALESCE\(st\.started_at, r\.started_at\)/);
  assert.match(close.sql, /UPDATE agent_run_steps SET status = 'failed'/);
  assert.match(close.sql, /UPDATE agent_runs SET status = 'failed'/);
  assert.match(close.sql, /UPDATE development_items SET status = 'blocked'.*status = 'in_progress'/s);
  assert.deepEqual(close.values, ['mainty', 'a-1', 60, ORPHAN_CANCEL_NOTE]);
});
