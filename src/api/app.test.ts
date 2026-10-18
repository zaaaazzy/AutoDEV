import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Pool } from 'pg';
import { createDevLogApp } from './app.js';
import { currentStep, hotp } from './totp.js';

const auth = { username: 'dev-log-user', password: 'a-long-enough-local-password' };

async function withServer(pool: Pool, action: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createDevLogApp(pool, auth).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    await action(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function basicAuth(): string {
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
}

test('protects the API; basic auth works for scripts while no second factor is set up', async () => {
  const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
  await withServer(pool, async (baseUrl) => {
    const anonymous = await fetch(`${baseUrl}/api/projects`);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get('www-authenticate'), null);

    const authorized = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: basicAuth() },
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), { projects: [] });
  });
});

/** Speicher für Sitzungen und Einstellungen, damit Login und Zwei-Faktor ohne Datenbank laufen. */
function sessionPool(): Pool {
  const sessions = new Map<string, Date>();
  const settings = new Map<string, string>();
  return {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith('INSERT INTO auth_sessions')) sessions.set(values[0] as string, new Date());
      else if (sql.includes('FROM auth_sessions s')) {
        const seen = sessions.get(values[0] as string);
        return { rows: seen ? [{ last_seen: seen, user_id: null }] : [] };
      } else if (sql.startsWith('DELETE FROM auth_sessions WHERE token_hash <>')) {
        for (const key of [...sessions.keys()]) if (key !== values[0]) sessions.delete(key);
      } else if (sql.startsWith('DELETE FROM auth_sessions')) sessions.delete(values[0] as string);
      else if (sql.includes('INTO app_settings')) settings.set(values[0] as string, values[1] as string);
      else if (sql.startsWith('SELECT value FROM app_settings')) {
        const value = settings.get(values[0] as string);
        return { rows: value ? [{ value }] : [] };
      } else if (sql.startsWith('DELETE FROM app_settings')) settings.delete(values[0] as string);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
}

test('login creates a session cookie; with a second factor basic auth and code-less logins are refused', async () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const pool = sessionPool();
  const totpAuth = { ...auth, totpSecret: secret as string | null };
  const server = createDevLogApp(pool, totpAuth).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const json = { 'Content-Type': 'application/json' };
    const session = await (await fetch(`${baseUrl}/api/session`)).json();
    assert.deepEqual(session, { authenticated: false, authRequired: true, totp: true, user: null });

    assert.equal((await fetch(`${baseUrl}/api/projects`, { headers: { Authorization: basicAuth() } })).status, 401);
    const withoutCode = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ username: auth.username, password: auth.password }),
    });
    assert.equal(withoutCode.status, 401);

    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ username: auth.username, password: auth.password, code: hotp(secret, currentStep()) }),
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    assert.match(login.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Lax/);
    assert.equal((await fetch(`${baseUrl}/api/projects`, { headers: { Cookie: cookie } })).status, 200);

    const replay = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ username: auth.username, password: auth.password, code: hotp(secret, currentStep()) }),
    });
    assert.equal(replay.status, 401, 'a code is accepted only once');

    await fetch(`${baseUrl}/api/logout`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal((await fetch(`${baseUrl}/api/projects`, { headers: { Cookie: cookie } })).status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('serves the Angular application shell', async () => {
  const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
  await withServer(pool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`, {
      headers: { Authorization: basicAuth() },
    });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /<app-root><\/app-root>/);
    assert.match(html, /<base href="\.\/"\s*\/?>/);
    assert.match(html, /main-[\w-]+\.js/);
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
      body: JSON.stringify({
        title: 'Sprints',
        effortHours: 12.5,
        tokenEstimate: 40000,
        benefit: 8,
        cost: 3,
        category: 'frontend',
      }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(queries[0]?.values.slice(5), [12.5, 40000, 8, 3, 'frontend']);

    for (const invalid of [
      { benefit: 11 },
      { cost: -1 },
      { benefit: 2.5 },
      { tokenEstimate: 'x' },
      { category: 'mobile' },
    ]) {
      const response = await fetch(`${baseUrl}/api/ideation/${ID}`, {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify(invalid),
      });
      assert.equal(response.status, 400);
    }
    const patched = await fetch(`${baseUrl}/api/ideation/${ID}`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ benefit: null, cost: 4 }),
    });
    assert.equal(patched.status, 200);
    const update = queries.at(-1);
    assert.match(update?.sql ?? '', /SET benefit = \$2, cost = \$3/);
    assert.deepEqual(update?.values, [ID, null, 4]);
  });
});

test('promotes an idea to a backlog order and rejects duplicates', async () => {
  const { pool, queries } = recordingPool([{ id: 'order' }]);
  await withServer(pool, async (baseUrl) => {
    const promoted = await fetch(`${baseUrl}/api/ideation/${ID}/promote`, {
      method: 'POST',
      headers: jsonHeaders(),
    });
    assert.equal(promoted.status, 201);
    assert.deepEqual(queries[0]?.values, [ID]);
    assert.match(queries[1]?.sql ?? '', /status = 'accepted'/);

    const invalid = await fetch(`${baseUrl}/api/ideation/nope/promote`, { method: 'POST', headers: jsonHeaders() });
    assert.equal(invalid.status, 400);
  });
  const empty = recordingPool([]);
  await withServer(empty.pool, async (baseUrl) => {
    const conflict = await fetch(`${baseUrl}/api/ideation/${ID}/promote`, { method: 'POST', headers: jsonHeaders() });
    assert.equal(conflict.status, 409);
  });
});

test('stores image attachments for ideas and rejects other file types', async () => {
  const { pool, queries } = recordingPool([{ id: ID, filename: 'shot.png' }]);
  await withServer(pool, async (baseUrl) => {
    const stored = await fetch(`${baseUrl}/api/ideation/${ID}/attachments?name=${encodeURIComponent('../shot.png')}`, {
      method: 'POST',
      headers: { ...jsonHeaders(), 'Content-Type': 'image/png' },
      body: new Uint8Array([137, 80, 78, 71]),
    });
    assert.equal(stored.status, 201);
    assert.deepEqual(queries[0]?.values.slice(0, 4), [ID, 'shot.png', 'image/png', 4]);

    const svg = await fetch(`${baseUrl}/api/ideation/${ID}/attachments`, {
      method: 'POST',
      headers: { ...jsonHeaders(), 'Content-Type': 'image/svg+xml' },
      body: '<svg/>',
    });
    assert.equal(svg.status, 415);
  });
});

test('stores image attachments for bugs', async () => {
  const { pool, queries } = recordingPool([{ id: ID, filename: 'bug.png' }]);
  await withServer(pool, async (baseUrl) => {
    const stored = await fetch(`${baseUrl}/api/bugs/${ID}/attachments?name=bug.png`, {
      method: 'POST',
      headers: { ...jsonHeaders(), 'Content-Type': 'image/png' },
      body: new Uint8Array([137, 80, 78, 71]),
    });
    assert.equal(stored.status, 201);
    assert.match(queries[0]?.sql ?? '', /bug_id/);
    assert.deepEqual(queries[0]?.values.slice(0, 4), [ID, 'bug.png', 'image/png', 4]);
  });
});

test('manages sprints with validation and a single active sprint', async () => {
  const { pool, queries } = recordingPool([{ id: SPRINT_ID, name: 'Sprint 1' }]);
  await withServer(pool, async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/projects/mainty/sprints`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'Sprint 1', startDate: '2026-10-19', endDate: '2026-11-01' }),
    });
    assert.equal(created.status, 201);
    assert.equal(queries[0]?.values[4], '2026-10-19');

    const badDate = await fetch(`${baseUrl}/api/projects/mainty/sprints`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'S', startDate: '19.10.2026' }),
    });
    assert.equal(badDate.status, 400);
    const directActive = await fetch(`${baseUrl}/api/projects/mainty/sprints`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'S', status: 'active' }),
    });
    assert.equal(directActive.status, 400);
  });
  const conflictPool = {
    query: async () => {
      throw Object.assign(new Error('duplicate'), { code: '23505' });
    },
  } as unknown as Pool;
  await withServer(conflictPool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sprints/${SPRINT_ID}`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ status: 'active' }),
    });
    assert.equal(response.status, 409);
  });
});

test('assigns development orders to sprints only within the same project', async () => {
  const { pool, queries } = recordingPool([]);
  await withServer(pool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/development/${ID}`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ sprintId: SPRINT_ID }),
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
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'Entwickler', role: 'developer', phase: 'while_task', instructions: 'Setzt um' }),
    });
    assert.equal(created.status, 201);
    assert.equal(queries[0]?.values[3], 'while_task');

    const missingPhase = await fetch(`${baseUrl}/api/projects/mainty/agents`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'X' }),
    });
    assert.equal(missingPhase.status, 400);
    const badPhase = await fetch(`${baseUrl}/api/projects/mainty/agents`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'X', phase: 'during' }),
    });
    assert.equal(badPhase.status, 400);

    const ordered = await fetch(`${baseUrl}/api/projects/mainty/agents/order`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ phase: 'pre_task', ids: [ID, SPRINT_ID] }),
    });
    assert.equal(ordered.status, 204);
    assert.deepEqual(queries.at(-1)?.values, ['mainty', 'pre_task', [ID, SPRINT_ID]]);

    const badOrder = await fetch(`${baseUrl}/api/projects/mainty/agents/order`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ phase: 'pre_task', ids: ['x'] }),
    });
    assert.equal(badOrder.status, 400);

    const list = await fetch(`${baseUrl}/api/projects/mainty/agents`, { headers: jsonHeaders() });
    assert.equal(list.status, 200);
    assert.match(queries.at(-1)?.sql ?? '', /pre_task' THEN 0 WHEN 'while_task' THEN 1/);
  });
});

test('serves the Angular bundle from the application shell', async () => {
  await withServer(recordingPool().pool, async (baseUrl) => {
    const html = await (await fetch(`${baseUrl}/`, { headers: { Authorization: basicAuth() } })).text();
    assert.match(html, /<app-root><\/app-root>/);
    const scriptPath = html.match(/src="([^"]*main-[^"]+\.js)"/)?.[1];
    assert.ok(scriptPath);
    const script = await fetch(new URL(scriptPath, baseUrl), { headers: { Authorization: basicAuth() } });
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') ?? '', /javascript/);
  });
});

test('seeds the default agent workflow when a project is created', async () => {
  const { pool, queries } = recordingPool([{ slug: 'mainty' }]);
  await withServer(pool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ slug: 'mainty', name: 'Mainty', repository: '/repo' }),
    });
    assert.equal(response.status, 201);
    const seed = queries.at(-1);
    assert.match(seed?.sql ?? '', /INSERT INTO agents/);
    assert.equal(seed?.values[0], 'mainty');
    assert.deepEqual(seed?.values[3], [
      'pre_task',
      'pre_task',
      'while_task',
      'after_task',
      'after_task',
      'after_task',
      'after_task',
      'after_task',
    ]);
  });
});

test('stores an agent command as an argument array and rejects strings', async () => {
  const { pool, queries } = recordingPool([{ id: ID }]);
  await withServer(pool, async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/projects/mainty/agents`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'Dev', phase: 'while_task', command: ['claude', '-p'] }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(queries.at(-1)?.values[6], ['claude', '-p']);
    const invalid = await fetch(`${baseUrl}/api/agents/${ID}`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ command: 'rm -rf /' }),
    });
    assert.equal(invalid.status, 400);
  });
});

test('stores the number of concurrent agents within its limits', async () => {
  const stored: string[] = [];
  const pool = {
    query: async (sql: string, values?: string[]) => {
      if (/INSERT INTO app_settings/.test(sql)) stored.push(values![0]!);
      return { rows: stored.length ? [{ value: stored.at(-1) }] : [] };
    },
  } as unknown as Pool;
  await withServer(pool, async (baseUrl) => {
    const headers = { Authorization: basicAuth(), 'Content-Type': 'application/json' };
    const defaults = await fetch(`${baseUrl}/api/settings`, { headers });
    assert.equal(((await defaults.json()) as { maxConcurrentAgents: number }).maxConcurrentAgents, 2);
    const invalid = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ maxConcurrentAgents: 9 }),
    });
    assert.equal(invalid.status, 400);
    const saved = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ maxConcurrentAgents: 3 }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(stored, ['3']);
  });
});

test('sets security headers and rejects cross-origin writes', async () => {
  const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
  await withServer(pool, async (baseUrl) => {
    const headers = { Authorization: basicAuth() };
    const page = await fetch(`${baseUrl}/api/projects`, { headers });
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');

    const foreign = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { ...headers, Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(foreign.status, 403);
  });
});

test('behind the HTTPS proxy, same-origin writes over https are accepted', async () => {
  process.env.DEV_LOG_TRUST_PROXY = 'loopback';
  try {
    const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
    await withServer(pool, async (baseUrl) => {
      const host = new URL(baseUrl).host;
      const proxied = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(),
          Origin: `https://${host}`,
          'X-Forwarded-Proto': 'https',
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      assert.notEqual(proxied.status, 403);
    });
  } finally {
    delete process.env.DEV_LOG_TRUST_PROXY;
  }
});

test('blocks a client after repeated failed logins', async () => {
  const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
  await withServer(pool, async (baseUrl) => {
    const wrong = { Authorization: `Basic ${Buffer.from('dev-log-user:wrong-password').toString('base64')}` };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      assert.equal((await fetch(`${baseUrl}/api/projects`, { headers: wrong })).status, 401);
    }
    assert.equal((await fetch(`${baseUrl}/api/projects`, { headers: wrong })).status, 429);
    assert.equal((await fetch(`${baseUrl}/api/projects`, { headers: { Authorization: basicAuth() } })).status, 429);
  });
});

test('project ids are normalized and errors name the field', async () => {
  const { pool, queries } = recordingPool([
    { slug: 'kg1', name: 'KeyGuard', repository: '/Volumes/External/KeyGuard' },
  ]);
  await withServer(pool, async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ slug: 'KG1', name: 'KeyGuard', repository: '/Volumes/External/KeyGuard' }),
    });
    assert.equal(created.status, 201);
    assert.equal(queries.find((query) => query.sql.includes('INSERT INTO projects'))?.values[0], 'kg1');
    const missing = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ slug: 'kg1', name: 'KeyGuard' }),
    });
    assert.equal(missing.status, 400);
    assert.match(((await missing.json()) as { message: string }).message, /Projektordner/);
  });
});

test('a planner may read but not manage users or agents', async () => {
  const pool = {
    query: async (sql: string) =>
      sql.includes('FROM auth_sessions s')
        ? {
            rows: [
              {
                last_seen: new Date(),
                user_id: 'u1',
                username: 'pia',
                display_name: 'Pia',
                roles: ['plan'],
                active: true,
              },
            ],
          }
        : { rows: [], rowCount: 0 },
  } as unknown as Pool;
  await withServer(pool, async (baseUrl) => {
    const cookie = { Cookie: 'devlog_session=abc', 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${baseUrl}/api/projects`, { headers: cookie })).status, 200);
    const users = await fetch(`${baseUrl}/api/users`, { method: 'POST', headers: cookie, body: '{}' });
    assert.equal(users.status, 403);
    assert.match((await users.json()).message, /Administration/);
    const agent = await fetch(`${baseUrl}/api/agents/00000000-0000-0000-0000-000000000000`, {
      method: 'DELETE',
      headers: cookie,
    });
    assert.equal(agent.status, 403);
  });
});

test('a locked-out account does not lock out other accounts from the same address', async () => {
  const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
  await withServer(pool, async (baseUrl) => {
    const wrong = { Authorization: `Basic ${Buffer.from('jemand:falsch').toString('base64')}` };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await fetch(`${baseUrl}/api/projects`, { headers: wrong });
    }
    assert.equal((await fetch(`${baseUrl}/api/projects`, { headers: wrong })).status, 429);
    assert.equal((await fetch(`${baseUrl}/api/projects`, { headers: { Authorization: basicAuth() } })).status, 200);
  });
});

test('with a second factor, cached basic credentials neither count as failures nor block the login', async () => {
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
  const server = createDevLogApp(pool, { ...auth, totpSecret: 'JBSWY3DPEHPK3PXP' }).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cached = { Authorization: basicAuth() };
    for (let attempt = 0; attempt < 15; attempt += 1) {
      assert.equal((await fetch(`${baseUrl}/api/projects`, { headers: cached })).status, 401);
    }
    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: auth.username, password: auth.password }),
    });
    assert.equal(login.status, 401);
    assert.equal((await login.json()).totp, true, 'asks for the code instead of being locked out');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
