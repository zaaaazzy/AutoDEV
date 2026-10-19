import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Pool } from 'pg';
import { createDevLogApp } from './app.js';

/** Nummern der Platzhalter ($1, $2, …), die eine Abfrage verwendet. */
function placeholders(sql: string): number[] {
  return [...new Set([...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))].sort((a, b) => a - b);
}

test('Version starten (Sprint-Ansicht): die Abfrage nutzt genau die übergebenen Werte, in der richtigen Reihenfolge', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return { rows: sql.startsWith('UPDATE review_slots') ? [{ slot: 1 }] : [], rowCount: 1 };
    },
  } as unknown as Pool;
  const server = createDevLogApp(pool, null).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const commit = 'a'.repeat(40);
    const response = await fetch(`http://127.0.0.1:${port}/api/projects/dev-log/review-slots/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commit, label: 'Sprint 2' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { slot: 1 });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const update = queries.find((query) => query.sql.startsWith('UPDATE review_slots'));
  assert.ok(update);
  // Ein unbenutzter Platzhalter scheitert in Postgres mit „could not determine data type of parameter $1“.
  assert.deepEqual(
    placeholders(update.sql),
    update.values.map((_value, index) => index + 1),
  );
  assert.match(update.sql, /project_slug = \$1\b/);
  assert.match(update.sql, /commit_sha = \$2\b/);
  assert.deepEqual(update.values.slice(0, 3), ['dev-log', 'a'.repeat(40), 'Sprint 2']);
});
