import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Pool } from 'pg';
import { createDevLogApp } from './app.js';

const ID = '11111111-1111-4111-8111-111111111111';
const SPRINT = '22222222-2222-4222-8222-222222222222';

/** Pool-Attrappe: jede Abfrage sieht einen Auftrag im Status `current` und einen Sprint im Status `sprintStatus`. */
async function patch(current: string, body: Record<string, unknown>, sprintStatus = 'active') {
  const queries: string[] = [];
  const row = { id: ID, status: current, projectSlug: 'dev-log', sprintStatus, sprint_status: sprintStatus, 1: 1 };
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [row], rowCount: 1 };
    },
  } as unknown as Pool;
  const server = createDevLogApp(pool, null).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/development/${ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, queries };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

for (const [from, to] of [
  ['planned', 'done'],
  ['backlog', 'done'],
  ['planned', 'approval'],
  ['planned', 'in_progress'],
  ['backlog', 'in_progress'],
  ['in_progress', 'backlog'],
  ['in_progress', 'planned'],
  ['done', 'planned'],
]) {
  test(`PATCH /development: ${from} → ${to} wird mit 409 abgelehnt und nichts geschrieben`, async () => {
    const result = await patch(from, { status: to });
    assert.equal(result.status, 409);
    assert.ok(!result.queries.some((sql) => /^\s*UPDATE development_items/i.test(sql)));
  });
}

for (const [from, to] of [
  ['backlog', 'planned'],
  ['planned', 'backlog'],
  ['blocked', 'planned'],
  ['planned', 'rejected'],
]) {
  test(`PATCH /development: ${from} → ${to} bleibt erlaubt`, async () => {
    const result = await patch(from, { status: to });
    assert.equal(result.status, 200);
  });
}

test('PATCH /development: Zuordnung zu abgeschlossenem Sprint wird mit 409 abgelehnt', async () => {
  for (const sprintStatus of ['completed', 'review']) {
    const result = await patch('backlog', { sprintId: SPRINT }, sprintStatus);
    assert.equal(result.status, 409, `Sprint im Status ${sprintStatus}`);
    assert.ok(!result.queries.some((sql) => /^\s*UPDATE development_items/i.test(sql)));
  }
});
