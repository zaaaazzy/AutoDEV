import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Pool } from 'pg';
import { createDevLogApp } from './app.js';

const auth = { username: 'dev-log-user', password: 'a-long-enough-local-password' };

async function withServer(
  pool: Pool,
  action: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createDevLogApp(pool, auth).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    await action(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function basicAuth(): string {
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
}

test('protects the Dev Log UI and API with HTTP basic authentication', async () => {
  const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
  await withServer(pool, async (baseUrl) => {
    const anonymous = await fetch(`${baseUrl}/api/projects`);
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get('www-authenticate') ?? '', /^Basic/);

    const authorized = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: basicAuth() },
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), { projects: [] });
  });
});

test('serves the standalone ideation and development interface', async () => {
  const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
  await withServer(pool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`, {
      headers: { Authorization: basicAuth() },
    });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Ideationboard/);
    assert.match(html, /Entwicklung/);
    assert.match(html, /id="project-select"/);
  });
});

test('validates board input and stores valid project-scoped ideas', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('INSERT INTO ideation_items')) {
        return { rows: [{ id: 'idea-id', title: values[1], status: values[3], priority: values[4] }] };
      }
      return { rows: [] };
    },
  } as unknown as Pool;
  await withServer(pool, async (baseUrl) => {
    const headers = {
      Authorization: basicAuth(),
      'Content-Type': 'application/json',
    };
    const invalid = await fetch(`${baseUrl}/api/projects/mainty/ideation`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: '' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(queries.length, 0);

    const created = await fetch(`${baseUrl}/api/projects/mainty/ideation`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Automated test report', status: 'idea', priority: 'high' }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), {
      item: { id: 'idea-id', title: 'Automated test report', status: 'idea', priority: 'high' },
    });
    assert.equal(queries[0]?.values[0], 'mainty');
  });
});

function recordingPool(rows: Record<string, unknown>[] = []) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return { rows };
    },
  } as unknown as Pool;
  return { pool, queries };
}

const jsonHeaders = () => ({ Authorization: basicAuth(), 'Content-Type': 'application/json' });
const ID = '11111111-1111-4111-8111-111111111111';
const SPRINT_ID = '22222222-2222-4222-8222-222222222222';

test('stores effort, token, benefit and cost estimates on ideas and rejects out-of-range scores', async () => {
  const { pool, queries } = recordingPool([{ id: ID }]);
  await withServer(pool, async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/projects/mainty/ideation`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ title: 'Sprints', effortHours: 12.5, tokenEstimate: 40000, benefit: 8, cost: 3 }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(queries[0]?.values.slice(5), [12.5, 40000, 8, 3]);

    for (const invalid of [{ benefit: 11 }, { cost: -1 }, { benefit: 2.5 }, { tokenEstimate: 'x' }]) {
      const response = await fetch(`${baseUrl}/api/ideation/${ID}`, {
        method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(invalid),
      });
      assert.equal(response.status, 400);
    }
    const patched = await fetch(`${baseUrl}/api/ideation/${ID}`, {
      method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ benefit: null, cost: 4 }),
    });
    assert.equal(patched.status, 200);
    const update = queries.at(-1);
    assert.match(update?.sql ?? '', /SET benefit = \$2, cost = \$3/);
    assert.deepEqual(update?.values, [ID, null, 4]);
  });
});

test('promotes an idea to a development order inside a sprint and rejects duplicates', async () => {
  const { pool, queries } = recordingPool([{ id: 'order' }]);
  await withServer(pool, async (baseUrl) => {
    const promoted = await fetch(`${baseUrl}/api/ideation/${ID}/promote`, {
      method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ sprintId: SPRINT_ID }),
    });
    assert.equal(promoted.status, 201);
    assert.deepEqual(queries[0]?.values, [ID, SPRINT_ID]);
    assert.match(queries[1]?.sql ?? '', /status = 'accepted'/);

    const invalid = await fetch(`${baseUrl}/api/ideation/${ID}/promote`, {
      method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ sprintId: 'nope' }),
    });
    assert.equal(invalid.status, 400);
  });
  const empty = recordingPool([]);
  await withServer(empty.pool, async (baseUrl) => {
    const conflict = await fetch(`${baseUrl}/api/ideation/${ID}/promote`, { method: 'POST', headers: jsonHeaders() });
    assert.equal(conflict.status, 409);
  });
});

test('manages sprints with validation and a single active sprint', async () => {
  const { pool, queries } = recordingPool([{ id: SPRINT_ID, name: 'Sprint 1' }]);
  await withServer(pool, async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/projects/mainty/sprints`, {
      method: 'POST', headers: jsonHeaders(),
      body: JSON.stringify({ name: 'Sprint 1', startDate: '2026-10-19', endDate: '2026-11-01' }),
    });
    assert.equal(created.status, 201);
    assert.equal(queries[0]?.values[4], '2026-10-19');

    const badDate = await fetch(`${baseUrl}/api/projects/mainty/sprints`, {
      method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name: 'S', startDate: '19.10.2026' }),
    });
    assert.equal(badDate.status, 400);
    const directActive = await fetch(`${baseUrl}/api/projects/mainty/sprints`, {
      method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name: 'S', status: 'active' }),
    });
    assert.equal(directActive.status, 400);
  });
  const conflictPool = {
    query: async () => { throw Object.assign(new Error('duplicate'), { code: '23505' }); },
  } as unknown as Pool;
  await withServer(conflictPool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sprints/${SPRINT_ID}`, {
      method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ status: 'active' }),
    });
    assert.equal(response.status, 409);
  });
});

test('assigns development orders to sprints only within the same project', async () => {
  const { pool, queries } = recordingPool([]);
  await withServer(pool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/development/${ID}`, {
      method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ sprintId: SPRINT_ID }),
    });
    assert.equal(response.status, 400);
    assert.equal(queries.length, 1);
    assert.match(queries[0]?.sql ?? '', /s\.project_slug|project_slug = s\.project_slug/);
  });
});

test('defines agents per workflow phase and persists their order', async () => {
  const { pool, queries } = recordingPool([{ id: ID }]);
  await withServer(pool, async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/projects/mainty/agents`, {
      method: 'POST', headers: jsonHeaders(),
      body: JSON.stringify({ name: 'Entwickler', role: 'developer', phase: 'while_task', instructions: 'Setzt um' }),
    });
    assert.equal(created.status, 201);
    assert.equal(queries[0]?.values[3], 'while_task');

    const missingPhase = await fetch(`${baseUrl}/api/projects/mainty/agents`, {
      method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name: 'X' }),
    });
    assert.equal(missingPhase.status, 400);
    const badPhase = await fetch(`${baseUrl}/api/projects/mainty/agents`, {
      method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name: 'X', phase: 'during' }),
    });
    assert.equal(badPhase.status, 400);

    const ordered = await fetch(`${baseUrl}/api/projects/mainty/agents/order`, {
      method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ phase: 'pre_task', ids: [ID, SPRINT_ID] }),
    });
    assert.equal(ordered.status, 204);
    assert.deepEqual(queries.at(-1)?.values, ['mainty', 'pre_task', [ID, SPRINT_ID]]);

    const badOrder = await fetch(`${baseUrl}/api/projects/mainty/agents/order`, {
      method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ phase: 'pre_task', ids: ['x'] }),
    });
    assert.equal(badOrder.status, 400);

    const list = await fetch(`${baseUrl}/api/projects/mainty/agents`, { headers: jsonHeaders() });
    assert.equal(list.status, 200);
    assert.match(queries.at(-1)?.sql ?? '', /pre_task' THEN 0 WHEN 'while_task' THEN 1/);
  });
});

test('serves sprint and agent views in the interface', async () => {
  await withServer(recordingPool().pool, async (baseUrl) => {
    const html = await (await fetch(`${baseUrl}/`, { headers: { Authorization: basicAuth() } })).text();
    assert.match(html, /data-section="sprints"/);
    assert.match(html, /data-section="agents"/);
    assert.match(html, /Pre Task/);
    assert.match(html, /name="benefit"/);
  });
});

test('seeds the default agent workflow when a project is created', async () => {
  const { pool, queries } = recordingPool([{ slug: 'mainty' }]);
  await withServer(pool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST', headers: jsonHeaders(),
      body: JSON.stringify({ slug: 'mainty', name: 'Mainty', repository: '/repo' }),
    });
    assert.equal(response.status, 201);
    const seed = queries.at(-1);
    assert.match(seed?.sql ?? '', /INSERT INTO agents/);
    assert.equal(seed?.values[0], 'mainty');
    assert.deepEqual(seed?.values[3], ['pre_task', 'pre_task', 'while_task', 'after_task', 'after_task', 'after_task']);
  });
});

test('stores an agent command as an argument array and rejects strings', async () => {
  const { pool, queries } = recordingPool([{ id: ID }]);
  await withServer(pool, async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/projects/mainty/agents`, {
      method: 'POST', headers: jsonHeaders(),
      body: JSON.stringify({ name: 'Dev', phase: 'while_task', command: ['claude', '-p'] }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(queries.at(-1)?.values[6], ['claude', '-p']);
    const invalid = await fetch(`${baseUrl}/api/agents/${ID}`, {
      method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ command: 'rm -rf /' }),
    });
    assert.equal(invalid.status, 400);
  });
});
