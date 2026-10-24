import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Pool } from 'pg';
import { loadProjectPermissions } from '../agent/tool-permissions.js';
import { loadProjectContext } from '../core/project-context.js';
import { createDevLogApp } from './app.js';
import { loadTotpSecret } from './auth.js';

const failing = (code?: string) =>
  ({
    query: async () => {
      throw Object.assign(new Error('Datenbank weg'), { code });
    },
  }) as unknown as Pool;

test('a database error does not enable every permission group', async () => {
  await assert.rejects(loadProjectPermissions(failing('ECONNREFUSED'), 'demo'), /Datenbank weg/);
});

test('a database error does not switch off the second factor', async () => {
  await assert.rejects(loadTotpSecret(failing('ECONNREFUSED')), /Datenbank weg/);
  assert.equal(await loadTotpSecret(failing('42P01')), null, 'fresh database without the table');
});

test('a database error does not let agents run without the project rules', async () => {
  await assert.rejects(loadProjectContext(failing(), 'demo'), /Datenbank weg/);
});

const BUG = '11111111-1111-4111-8111-111111111111';
const SPRINT = '22222222-2222-4222-8222-222222222222';

/** Bug-Route gegen eine Pool-Attrappe: Ziel-Sprint im Status `sprintStatus`, Bug aktuell im Sprint `currentSprintId`. */
async function bugRequest(
  method: 'POST' | 'PATCH',
  body: Record<string, unknown>,
  sprintStatus: string,
  currentSprintId: string | null = null,
) {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (/FROM sprints/.test(sql)) {
        return { rows: [{ status: sprintStatus, sprintStatus, currentSprintId }], rowCount: 1 };
      }
      return { rows: [{ id: BUG, projectSlug: 'dev-log', sprintId: SPRINT, 1: 1 }], rowCount: 1 };
    },
  } as unknown as Pool;
  const server = createDevLogApp(pool, null).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const path = method === 'POST' ? '/api/projects/dev-log/bugs' : `/api/bugs/${BUG}`;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      writes: queries.filter((sql) => /^\s*(INSERT INTO|UPDATE) (bugs|development_items)\b/i.test(sql)),
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

for (const sprintStatus of ['cancelled', 'completed', 'review']) {
  test(`PATCH /bugs: Zuordnung zu Sprint im Status ${sprintStatus} wird mit 409 abgelehnt, kein Auftrag entsteht`, async () => {
    const result = await bugRequest('PATCH', { sprintId: SPRINT }, sprintStatus);
    assert.equal(result.status, 409);
    assert.deepEqual(result.writes, []);
  });

  test(`POST /bugs: Sprint im Status ${sprintStatus} wird mit 409 abgelehnt, nichts angelegt`, async () => {
    const result = await bugRequest('POST', { title: 'Absturz', sprintId: SPRINT }, sprintStatus);
    assert.equal(result.status, 409);
    assert.deepEqual(result.writes, []);
  });
}

test('PATCH /bugs: Bug im bereits zugeordneten toten Sprint bleibt bearbeitbar', async () => {
  const result = await bugRequest('PATCH', { title: 'Neuer Titel', sprintId: SPRINT }, 'cancelled', SPRINT);
  assert.equal(result.status, 200);
});

test('PATCH /bugs: Zuordnung zu aktivem Sprint bleibt erlaubt', async () => {
  const result = await bugRequest('PATCH', { sprintId: SPRINT }, 'active');
  assert.equal(result.status, 200);
  assert.ok(result.writes.some((sql) => /INSERT INTO development_items/.test(sql)));
});
