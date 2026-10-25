import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Pool } from 'pg';
import { createDevLogApp } from './app.js';

/** Pool-Attrappe: merkt sich die Abfragen; der INSERT liefert den Status zurück, den die Abfrage gesetzt hätte. */
async function create(body: Record<string, unknown>) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (/^\s*INSERT INTO development_items/i.test(sql)) {
        return { rows: [{ id: 'neu', status: params[5] ?? 'backlog' }], rowCount: 1 };
      }
      return { rows: [{ 1: 1 }], rowCount: 1 };
    },
  } as unknown as Pool;
  const server = createDevLogApp(pool, null).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/projects/dev-log/development`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as { item?: { status: string }; field?: string };
    const inserts = queries.filter((query) => /^\s*INSERT INTO development_items/i.test(query.sql));
    return { status: response.status, json, inserts };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

for (const status of ['done', 'approval', 'in_progress', 'blocked', 'rejected']) {
  test(`POST /projects/:slug/development: Status ${status} wird mit 400 abgelehnt und nichts gespeichert`, async () => {
    const result = await create({ title: 'Neuer Auftrag', status });
    assert.equal(result.status, 400);
    assert.equal(result.json.field, 'status');
    assert.equal(result.inserts.length, 0);
  });
}

test('POST /projects/:slug/development: ohne Status entsteht ein Auftrag im Backlog', async () => {
  const result = await create({ title: 'Neuer Auftrag' });
  assert.equal(result.status, 201);
  assert.equal(result.inserts.length, 1);
  assert.equal(result.json.item?.status, 'backlog');
});

for (const status of ['backlog', 'planned']) {
  test(`POST /projects/:slug/development: Status ${status} bleibt erlaubt`, async () => {
    const result = await create({ title: 'Neuer Auftrag', status });
    assert.equal(result.status, 201);
    assert.equal(result.json.item?.status, status);
  });
}
