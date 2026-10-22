import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Pool } from 'pg';
import { createDevLogApp } from './app.js';
import { credentialVersion, hashPassword, verifyPassword } from './auth.js';
import { DEV_COLUMNS } from './development.js';
import { currentStep, hotp } from './totp.js';

// Unabhängig vom Projektbereich der Umgebung (der Worker setzt ihn, z. B. im Test-Gate).
delete process.env.DEV_LOG_PROJECT_ROOTS;

const auth = { username: 'dev-log-user', password: 'a-long-enough-local-password' };
// Zwei-Faktor-Schlüssel werden nur verschlüsselt gespeichert; dafür braucht es einen Schlüssel.
process.env.DEV_LOG_SECRET_KEY ??= 'ein-schluessel-nur-fuer-tests';
/** Bindung einer Benutzer-Sitzung an ihren Passwort-Hash (sonst gilt die Sitzung nicht). */
const boundUser = {
  password_hash: 'scrypt$salz$hash',
  credential_version: await credentialVersion(auth, 'scrypt$salz$hash'),
};

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

test('API paths are case-sensitive, so other spellings never reach a route past the login', async () => {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
  } as unknown as Pool;
  await withServer(pool, async (baseUrl) => {
    for (const path of ['/API/projects', '/Api/users', '/API/session']) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 404, path);
    }
    // Unter /api laufen die Wächter vor jeder Route, auch wenn der Rest anders geschrieben ist.
    assert.equal((await fetch(`${baseUrl}/api/Projects`)).status, 401);
    const restart = await fetch(`${baseUrl}/API/system/restart`, { method: 'POST' });
    assert.ok(restart.status >= 400, `POST /API/system/restart: ${restart.status}`);
    assert.deepEqual(queries, []);

    // Die richtige Schreibweise bleibt geschützt.
    assert.equal((await fetch(`${baseUrl}/api/users`)).status, 401);
  });
});

/** Speicher für Sitzungen und Einstellungen, damit Login und Zwei-Faktor ohne Datenbank laufen. */
function sessionPool(): Pool {
  const sessions = new Map<string, string>();
  const settings = new Map<string, string>();
  return {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith('INSERT INTO auth_sessions')) sessions.set(values[0] as string, values[4] as string);
      else if (sql.includes('FROM auth_sessions s')) {
        const version = sessions.get(values[0] as string);
        return { rows: version ? [{ last_seen: new Date(), user_id: null, credential_version: version }] : [] };
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

test('2FA einrichten verlangt das Passwort und bei aktivem zweitem Faktor einen Code des bisherigen Schlüssels', async () => {
  const totpAuth = { ...auth, totpSecret: null as string | null };
  const server = createDevLogApp(sessionPool(), totpAuth).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: auth.username, password: auth.password }),
    });
    const headers = {
      'Content-Type': 'application/json',
      Cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
    };
    const post = (path: string, body: unknown) =>
      fetch(`${baseUrl}/api/auth/totp/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

    // Ohne zweiten Faktor: das Passwort genügt, ohne oder mit falschem Passwort gibt es keinen Schlüssel.
    for (const body of [{}, { password: 'wrong-password' }]) {
      const denied = await post('setup', body);
      assert.equal(denied.status, 400);
      assert.equal((await denied.json()).field, 'password');
    }
    const first = await post('setup', { password: auth.password });
    assert.equal(first.status, 200);
    const firstSecret = ((await first.json()) as { secret: string }).secret;
    const code = hotp(firstSecret, currentStep());
    assert.equal((await post('enable', { code })).status, 400, 'enable needs the password as well');
    assert.equal((await post('enable', { password: auth.password, code })).status, 200);
    assert.equal(totpAuth.totpSecret, firstSecret);

    // Aktiver zweiter Faktor: Ersetzen nur mit Passwort und Code des bisherigen Schlüssels.
    const withoutCode = await post('setup', { password: auth.password });
    assert.equal(withoutCode.status, 400);
    assert.equal((await withoutCode.json()).field, 'currentCode');
    assert.equal((await post('setup', { password: auth.password, currentCode: '000000' })).status, 400);
    const currentCode = hotp(firstSecret, currentStep() + 1);
    const second = await post('setup', { password: auth.password, currentCode });
    assert.equal(second.status, 200);
    const secondSecret = ((await second.json()) as { secret: string }).secret;
    const newCode = hotp(secondSecret, currentStep());
    assert.equal((await post('enable', { password: auth.password, code: newCode })).status, 400);
    assert.equal(totpAuth.totpSecret, firstSecret, 'without the old code the key stays');
    // Derselbe alte Code wie beim Einrichten gilt beim Bestätigen noch – sonst müsste man auf den nächsten warten.
    assert.equal((await post('enable', { password: auth.password, currentCode, code: newCode })).status, 200);
    assert.equal(totpAuth.totpSecret, secondSecret);

    // Abschalten: ein Code allein (gestohlenes Cookie) genügt nicht, es braucht auch das Passwort.
    const offCode = hotp(secondSecret, currentStep() + 1);
    const codeOnly = await post('disable', { currentCode: offCode });
    assert.equal(codeOnly.status, 400);
    assert.equal(totpAuth.totpSecret, secondSecret, 'nothing changed without the password');
    // Falsches Passwort und falscher Code ergeben dieselbe Antwort.
    const wrongPassword = await (await post('disable', { password: 'wrong-password', currentCode: offCode })).json();
    const wrongCode = await (await post('disable', { password: auth.password, currentCode: '000000' })).json();
    assert.deepEqual(wrongPassword, wrongCode);
    assert.equal(totpAuth.totpSecret, secondSecret);
    assert.equal((await post('disable', { password: auth.password, currentCode: offCode })).status, 200);
    assert.equal(totpAuth.totpSecret, null);
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
    assert.deepEqual(update?.values.slice(0, 3), [ID, null, 4]);
  });
});

test('ideas cannot be patched while the author agent drafts them or once accepted', async () => {
  for (const status of ['requested', 'drafting', 'accepted']) {
    const queries: { sql: string; values: unknown[] }[] = [];
    const pool = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.startsWith('UPDATE ideation_items')) {
          return { rows: (values.at(-1) as string[]).includes(status) ? [{ id: ID, status }] : [] };
        }
        return { rows: sql.startsWith('SELECT 1 FROM ideation_items') ? [{}] : [] };
      },
    } as unknown as Pool;
    await withServer(pool, async (baseUrl) => {
      for (const body of [{ status: 'idea' }, { title: 'Neu' }]) {
        const response = await fetch(`${baseUrl}/api/ideation/${ID}`, {
          method: 'PATCH',
          headers: jsonHeaders(),
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 409, `${status}: ${JSON.stringify(body)}`);
      }
    });
    assert.match(queries[0]?.sql ?? '', /WHERE id = \$1 AND status = ANY\(\$3\)/);
  }
  const missing = recordingPool([]);
  await withServer(missing.pool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ideation/${ID}`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ title: 'Neu' }),
    });
    assert.equal(response.status, 404);
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
  const recording = recordingPool([{ id: SPRINT_ID, name: 'Sprint 1' }]);
  const { queries } = recording;
  // Noch kein anderer Sprint im Projekt (Namensprüfung), sonst wie gehabt.
  const pool = {
    query: async (sql: string, values: unknown[] = []) =>
      sql.startsWith('SELECT name FROM sprints') ? { rows: [] } : recording.pool.query(sql, values),
  } as unknown as Pool;
  await withServer(pool, async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/projects/mainty/sprints`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'Sprint 1', startDate: '2026-10-19', endDate: '2026-11-01' }),
    });
    assert.equal(created.status, 201);
    assert.equal(queries.find((query) => query.sql.includes('INSERT INTO sprints'))?.values[4], '2026-10-19');

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

/** Sprint-Speicher für Statuswechsel: SELECT liefert Status und laufende Aufträge, UPDATE prüft den Status atomar. */
function sprintPool(sprint: { status: string; running?: number } | null) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (!sprint) return { rows: [] };
      if (sql.includes('FROM sprints s WHERE id'))
        return { rows: [{ status: sprint.status, running: sprint.running ?? 0 }] };
      if (sql.startsWith('UPDATE sprints SET') && sql.includes('= ANY(')) {
        const allowed = values.at(-1) as string[];
        if (!allowed.includes(sprint.status)) return { rows: [] };
        const status = sql.includes('status = $2') ? (values[1] as string) : sprint.status;
        return { rows: [{ id: SPRINT_ID, status }] };
      }
      if (sql.startsWith('UPDATE sprints SET')) return { rows: [{ id: SPRINT_ID, status: sprint.status }] };
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, queries };
}

async function patchSprint(baseUrl: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api/sprints/${SPRINT_ID}`, {
    method: 'PATCH',
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
}

test('sprint status changes follow the transition table and are checked atomically', async () => {
  for (const [from, to] of [
    ['completed', 'planned'],
    ['planned', 'completed'],
    ['planned', 'planned'],
    ['completed', 'completed'],
    ['review', 'active'],
  ] as const) {
    const { pool, queries } = sprintPool({ status: from });
    await withServer(pool, async (baseUrl) => {
      const response = await patchSprint(baseUrl, { status: to });
      assert.equal(response.status, 409, `${from} → ${to}`);
      assert.equal(queries.filter((query) => query.sql.startsWith('UPDATE')).length, 0, `${from} → ${to}`);
    });
  }

  // Abschluss nur ohne laufende Aufträge.
  const running = sprintPool({ status: 'active', running: 1 });
  await withServer(running.pool, async (baseUrl) => {
    assert.equal((await patchSprint(baseUrl, { status: 'completed' })).status, 409);
    assert.equal(running.queries.filter((query) => query.sql.startsWith('UPDATE')).length, 0);
  });

  // Erlaubter Wechsel: Statusbedingung im UPDATE.
  const start = sprintPool({ status: 'planned' });
  await withServer(start.pool, async (baseUrl) => {
    assert.equal((await patchSprint(baseUrl, { status: 'active' })).status, 200);
    const update = start.queries.find((query) => query.sql.startsWith('UPDATE sprints'));
    assert.match(update?.sql ?? '', /WHERE id = \$1 AND status = ANY\(\$3\)/);
    assert.deepEqual(update?.values, [SPRINT_ID, 'active', ['planned']]);
  });

  // Wieder öffnen bleibt möglich.
  const reopen = sprintPool({ status: 'completed' });
  await withServer(reopen.pool, async (baseUrl) => {
    assert.equal((await patchSprint(baseUrl, { status: 'active' })).status, 200);
  });

  // Status zwischen Prüfung und UPDATE geändert (z. B. vom Worker) → 409 statt Überschreiben.
  const raced = sprintPool({ status: 'planned' });
  const racedQuery = raced.pool.query.bind(raced.pool);
  (raced.pool as unknown as { query: unknown }).query = async (sql: string, values: unknown[] = []) => {
    const result = await racedQuery(sql, values);
    if (sql.includes('FROM sprints s WHERE id')) return { rows: [{ status: 'active', running: 0 }] };
    return result;
  };
  await withServer(raced.pool, async (baseUrl) => {
    assert.equal((await patchSprint(baseUrl, { status: 'completed' })).status, 409);
  });

  // Ohne Statuswechsel bleibt das UPDATE wie bisher.
  const rename = sprintPool({ status: 'completed' });
  await withServer(rename.pool, async (baseUrl) => {
    assert.equal((await patchSprint(baseUrl, { name: 'Neu' })).status, 200);
    const update = rename.queries.find((query) => query.sql.startsWith('UPDATE sprints'));
    assert.doesNotMatch(update?.sql ?? '', /ANY/);
  });

  const missing = sprintPool(null);
  await withServer(missing.pool, async (baseUrl) => {
    assert.equal((await patchSprint(baseUrl, { status: 'active' })).status, 404);
  });
});

test('deletes only planned or completed sprints without running work', async () => {
  // DELETE trifft keine Zeile (aktiv, Review, laufende Aufträge oder Git-Sicherung), der Sprint existiert aber.
  const blocked: { sql: string; values: unknown[] }[] = [];
  const blockedPool = {
    query: async (sql: string, values: unknown[] = []) => {
      blocked.push({ sql, values });
      return { rows: sql.startsWith('SELECT 1 FROM sprints') ? [{ '?column?': 1 }] : [] };
    },
  } as unknown as Pool;
  await withServer(blockedPool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sprints/${SPRINT_ID}`, { method: 'DELETE', headers: jsonHeaders() });
    assert.equal(response.status, 409);
    // Erst gehen geplante Aufträge ins Backlog (nur wenn der Sprint löschbar ist), dann wird gelöscht.
    assert.match(blocked[0]?.sql ?? '', /^UPDATE development_items SET status = 'backlog'/);
    assert.match(blocked[1]?.sql ?? '', /^DELETE FROM sprints/);
    for (const query of blocked.slice(0, 2)) {
      assert.match(query.sql, /status IN \('planned', 'completed', 'cancelled'\)/);
      assert.match(query.sql, /in_progress/);
      assert.match(query.sql, /git_sync IS NULL OR git_sync IN \('done', 'failed'\)/);
    }
  });

  const missing = recordingPool([]);
  await withServer(missing.pool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sprints/${SPRINT_ID}`, { method: 'DELETE', headers: jsonHeaders() });
    assert.equal(response.status, 404);
  });

  const deletable = recordingPool([{ id: SPRINT_ID }]);
  await withServer(deletable.pool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sprints/${SPRINT_ID}`, { method: 'DELETE', headers: jsonHeaders() });
    assert.equal(response.status, 204);
  });
});

test('new sprints can only be created as planned', async () => {
  const { pool, queries } = recordingPool([{ id: SPRINT_ID }]);
  await withServer(pool, async (baseUrl) => {
    for (const status of ['active', 'completed', 'review']) {
      const response = await fetch(`${baseUrl}/api/projects/mainty/sprints`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name: 'S', status }),
      });
      assert.equal(response.status, 400, status);
    }
    assert.equal(queries.length, 0);
    const planned = await fetch(`${baseUrl}/api/projects/mainty/sprints`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'S', status: 'planned' }),
    });
    assert.equal(planned.status, 201);
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

test('fixStatus vergleicht mit failure_bug_id des äusseren Auftrags, nicht des Behebungsauftrags', () => {
  // Hätte die innere Tabelle eine Spalte failure_bug_id, löste Postgres das unqualifizierte failure_bug_id auf sie
  // auf (f.bug_id = f.failure_bug_id) und fixStatus bliebe immer leer. Gegen Postgres 16 geprüft: Board-SELECT und
  // `UPDATE development_items d … RETURNING` liefern den Status des Behebungsauftrags.
  const subselect = /\(SELECT f\.status FROM ([\s\S]*?) AS "fixStatus"/.exec(DEV_COLUMNS)?.[1] ?? '';
  assert.match(
    subselect,
    /^\(SELECT bug_id, status, created_at FROM development_items\) f\s+WHERE f\.bug_id = failure_bug_id/,
  );
  assert.doesNotMatch(subselect, /f\.failure_bug_id|development_items f\b/);
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
    const insert = queries.find((query) => query.sql.includes('INSERT INTO agents'));
    assert.equal(insert?.values[3], 'while_task');
    // Jeder Befehl wird einzeln gesetzt: ohne Angabe bekommt ein neuer Agent keine Befehle.
    assert.deepEqual(insert?.values[7], []);

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
    // Workflow-Reihenfolge: vor dem Sprint, vor dem Auftrag, während, danach, bei abgelehnt, bei abgeschlossen.
    assert.match(queries.at(-1)?.sql ?? '', /'pre_sprint' THEN 0 WHEN 'pre_task' THEN 1 WHEN 'while_task' THEN 2/);
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
    // Danach folgen die Standard-Aktionen für den Tester (eigener Test in default-actions.test.ts).
    const seed = queries.find((query) => /INSERT INTO agents/.test(query.sql));
    assert.ok(seed);
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
      'after_task',
    ]);
    // Der visuelle Tester steht direkt nach dem Tester.
    assert.deepEqual((seed?.values[2] as string[]).slice(3, 5), ['tester', 'visual_tester']);
  });
});

test('refuses an existing project ID with 409 and changes nothing', async () => {
  // ON CONFLICT DO NOTHING liefert keine Zeile zurück.
  const { pool, queries } = recordingPool([]);
  await withServer(pool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ slug: 'mainty', name: 'Fremd', repository: '/other/repo' }),
    });
    assert.equal(response.status, 409);
    const insert = queries.find((query) => /INSERT INTO projects/.test(query.sql));
    assert.match(insert?.sql ?? '', /ON CONFLICT \(slug\) DO NOTHING/);
    assert.doesNotMatch(insert?.sql ?? '', /DO UPDATE/);
    assert.equal(
      queries.some((query) => /INSERT INTO agents|UPDATE projects/.test(query.sql)),
      false,
    );
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

test('Login: falsches Passwort des Systemadministrators dauert so lange wie ein scrypt-Vergleich', async () => {
  const stored = await hashPassword('x');
  let scryptMs = Infinity;
  for (let run = 0; run < 3; run += 1) {
    const start = performance.now();
    await verifyPassword('y', stored);
    scryptMs = Math.min(scryptMs, performance.now() - start);
  }
  const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
  await withServer(pool, async (baseUrl) => {
    const login = async (username: string) => {
      const start = performance.now();
      const response = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'wrong-password' }),
      });
      assert.equal(response.status, 401);
      return performance.now() - start;
    };
    await login('unbekannt'); // erzeugt den Dummy-Hash
    const elapsed = await login(auth.username);
    // Vorher antwortete der Server für den .env-Namen ohne scrypt sofort.
    assert.ok(elapsed >= scryptMs * 0.5, `${elapsed.toFixed(1)} ms < halber scrypt (${scryptMs.toFixed(1)} ms)`);
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
                ...boundUser,
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

/** Sitzung eines Benutzers mit den angegebenen Rollen, freigeschaltet für Projekt „p“; weitere Abfragen über `answer`. */
function memberPool(roles: string[], answer: (sql: string, values: unknown[]) => unknown = () => undefined): Pool {
  return {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('FROM auth_sessions s')) {
        return {
          rows: [
            {
              last_seen: new Date(),
              user_id: 'u1',
              username: 'pia',
              display_name: 'Pia',
              roles,
              active: true,
              ...boundUser,
            },
          ],
        };
      }
      if (sql.includes('FROM project_members')) return { rows: [{ slug: 'p' }] };
      return answer(sql, values) ?? { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
}

const IDEA_ID = '11111111-1111-4111-8111-111111111111';
const sessionHeaders = { Cookie: 'devlog_session=abc', 'Content-Type': 'application/json' };

test('Rolle „Ausführen“ darf über agentId nur einen Agent starten, nicht den Auftrag ändern', async () => {
  const writes: string[] = [];
  const pool = memberPool(['run'], (sql) => {
    if (sql.startsWith('UPDATE')) writes.push(sql);
    return undefined;
  });
  await withServer(pool, async (baseUrl) => {
    const patch = (body: unknown) =>
      fetch(`${baseUrl}/api/development/${IDEA_ID}`, {
        method: 'PATCH',
        headers: sessionHeaders,
        body: JSON.stringify(body),
      });
    for (const body of [
      { agentId: null, title: 'Gekapert', status: 'done' },
      { agentId: IDEA_ID, priority: 'high' },
      { agentId: null },
    ]) {
      const denied = await patch(body);
      assert.equal(denied.status, 403, JSON.stringify(body));
      assert.match((await denied.json()).message, /Planung/);
    }
    assert.deepEqual(writes, []);
    assert.notEqual((await patch({ agentId: IDEA_ID })).status, 403, 'Agent starten bleibt erlaubt');
  });
  await withServer(memberPool(['plan']), async (baseUrl) => {
    const denied = await fetch(`${baseUrl}/api/development/${IDEA_ID}`, {
      method: 'PATCH',
      headers: sessionHeaders,
      body: JSON.stringify({ agentId: IDEA_ID, title: 'x' }),
    });
    assert.equal(denied.status, 403, 'Planung allein startet keinen Agent');
    assert.match((await denied.json()).message, /Agents ausführen/);
  });
});

test('Schrägstrich am Pfadende umgeht die Rolle „Ausführen“ nicht (nur Planung: 403, kein UPDATE)', async () => {
  const writes: string[] = [];
  const pool = memberPool(['plan'], (sql) => {
    if (/^\s*(UPDATE|INSERT|DELETE)/.test(sql)) writes.push(sql);
    return undefined;
  });
  await withServer(pool, async (baseUrl) => {
    const requests: [string, string, unknown?][] = [
      ['PATCH', `/api/development/${IDEA_ID}/`, { agentId: IDEA_ID }],
      ['PATCH', `/api/development/${IDEA_ID}//`, { agentId: IDEA_ID }],
      ['POST', `/api/development/${IDEA_ID}/approve/`],
      ['POST', `/api/development/${IDEA_ID}/retry/`],
      ['POST', `/api/bugs/${IDEA_ID}/approve/`],
      ['POST', `/api/sprints/${SPRINT_ID}/git-sync/`],
      ['POST', `/api/sprints/${SPRINT_ID}/pause/`],
      ['POST', `/api/sprints/${SPRINT_ID}/resume/`],
      ['POST', `/api/agent-tasks/${IDEA_ID}/pause/`],
      ['POST', `/api/agent-tasks/${IDEA_ID}/resume/`],
    ];
    for (const [method, path, body] of requests) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: sessionHeaders,
        body: JSON.stringify(body ?? {}),
      });
      assert.ok([403, 404].includes(response.status), `${method} ${path}: ${response.status}`);
    }
  });
  assert.deepEqual(writes, []);
});

test('Visionär-Lauf: ohne Rolle „Planung“ 403, mit Planung angefragt, je Projekt nur einer, abbrechbar', async () => {
  await withServer(memberPool(['chat']), async (baseUrl) => {
    const denied = await fetch(`${baseUrl}/api/projects/p/ideation/visionary`, {
      method: 'POST',
      headers: sessionHeaders,
    });
    assert.equal(denied.status, 403);
    assert.match((await denied.json()).message, /Planung/);
  });
  let open = false;
  const run = () => ({ id: 'r1', status: open ? 'requested' : 'cancelled', progress: null });
  const pool = memberPool(['plan'], (sql) => {
    if (sql.startsWith('SELECT 1 FROM projects')) return { rows: [{}], rowCount: 1 };
    if (sql.includes('INSERT INTO visionary_runs')) {
      if (open) return { rows: [] };
      open = true;
      return { rows: [{ id: 'r1' }] };
    }
    if (sql.includes("SET status = 'cancelled'")) {
      const was = open;
      open = false;
      return { rows: was ? [{ id: 'r1' }] : [], rowCount: was ? 1 : 0 };
    }
    if (sql.includes('FROM visionary_runs')) return { rows: [run()] };
    return undefined;
  });
  await withServer(pool, async (baseUrl) => {
    const path = `${baseUrl}/api/projects/p/ideation/visionary`;
    const started = await fetch(path, { method: 'POST', headers: sessionHeaders });
    assert.equal(started.status, 202);
    assert.equal((await started.json()).run.status, 'requested');
    assert.equal((await fetch(path, { method: 'POST', headers: sessionHeaders })).status, 409);
    assert.equal(
      ((await (await fetch(path, { headers: sessionHeaders })).json()) as { run: { id: string } }).run.id,
      'r1',
    );
    const cancelled = await fetch(`${path}/cancel`, { method: 'POST', headers: sessionHeaders });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).run.status, 'cancelled');
    assert.equal((await fetch(`${path}/cancel`, { method: 'POST', headers: sessionHeaders })).status, 409);
  });
});

test('Ablehnen mit Grund: Status rejected, Grund an der Idee und als Kommentar', async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const pool = memberPool(['plan'], (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('FROM ideation_items WHERE id = $1') && sql.startsWith('SELECT project_slug')) {
      return { rows: [{ slug: 'p' }] };
    }
    if (sql.startsWith('UPDATE ideation_items')) {
      return { rows: [{ id: IDEA_ID, status: 'rejected', rejectionReason: values[1] }] };
    }
    return undefined;
  });
  await withServer(pool, async (baseUrl) => {
    const path = `${baseUrl}/api/ideation/${IDEA_ID}/reject`;
    const empty = await fetch(path, { method: 'POST', headers: sessionHeaders, body: '{"reason":"  "}' });
    assert.equal(empty.status, 400);
    const rejected = await fetch(path, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({ reason: 'Kein Bedarf im Team' }),
    });
    assert.equal(rejected.status, 200);
    assert.equal((await rejected.json()).item.status, 'rejected');
  });
  const update = calls.find((call) => call.sql.startsWith('UPDATE ideation_items'))!;
  assert.match(update.sql, /status = 'rejected', rejection_reason = \$2/);
  assert.deepEqual(update.values.slice(0, 2), [IDEA_ID, 'Kein Bedarf im Team']);
  const comment = calls.find((call) => call.sql.includes('INSERT INTO ideation_comments'))!;
  assert.deepEqual(comment.values, [IDEA_ID, 'Pia', '**Abgelehnt:** Kein Bedarf im Team']);
});

test('Filter „Herkunft“: das Board liefert auf Wunsch nur Ideen des Visionärs', async () => {
  const sources: unknown[] = [];
  const pool = memberPool(['plan'], (sql, values) => {
    if (sql.includes('FROM ideation_items WHERE project_slug = $1')) {
      assert.match(sql, /source = \$2/);
      sources.push(values[1]);
    }
    return undefined;
  });
  await withServer(pool, async (baseUrl) => {
    for (const query of ['?source=visionary', '', '?source=erfunden']) {
      assert.equal((await fetch(`${baseUrl}/api/projects/p/board${query}`, { headers: sessionHeaders })).status, 200);
    }
  });
  assert.deepEqual(sources, ['visionary', null, null]);
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

test('behind the proxy, failed logins for the admin name from one client do not lock out the admin elsewhere', async () => {
  process.env.DEV_LOG_TRUST_PROXY = 'loopback';
  try {
    const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
    await withServer(pool, async (baseUrl) => {
      const attacker = {
        Authorization: `Basic ${Buffer.from(`${auth.username}:falsch`).toString('base64')}`,
        'X-Forwarded-For': '198.51.100.9',
      };
      for (let attempt = 0; attempt < 10; attempt += 1) {
        assert.equal((await fetch(`${baseUrl}/api/projects`, { headers: attacker })).status, 401);
      }
      const blocked = await fetch(`${baseUrl}/api/projects`, { headers: attacker });
      assert.equal(blocked.status, 429);
      assert.equal(blocked.headers.get('retry-after'), '60', 'erste Wartezeit eine Minute statt 15');
      const admin = { Authorization: basicAuth(), 'X-Forwarded-For': '203.0.113.1' };
      assert.equal((await fetch(`${baseUrl}/api/projects`, { headers: admin })).status, 200);
    });
  } finally {
    delete process.env.DEV_LOG_TRUST_PROXY;
  }
});

test('DEV_LOG_TRUST_PROXY=true is rejected: a forged X-Forwarded-For does not get around the lockout', async () => {
  process.env.DEV_LOG_TRUST_PROXY = 'true';
  try {
    const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
    await withServer(pool, async (baseUrl) => {
      const wrong = (attempt: number) => ({
        Authorization: `Basic ${Buffer.from(`${auth.username}:falsch`).toString('base64')}`,
        'X-Forwarded-For': `198.51.100.${attempt + 1}`,
      });
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await fetch(`${baseUrl}/api/projects`, { headers: wrong(attempt) });
      }
      assert.equal((await fetch(`${baseUrl}/api/projects`, { headers: wrong(50) })).status, 429);
    });
  } finally {
    delete process.env.DEV_LOG_TRUST_PROXY;
  }
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

test('Sprint-Name mit gleichem Git-Branch wie ein anderer Sprint wird abgelehnt', async () => {
  const pool = {
    query: async (sql: string) =>
      sql.startsWith('SELECT name FROM sprints') ? { rows: [{ name: 'Sprint 5' }] } : { rows: [{ id: SPRINT_ID }] },
  } as unknown as Pool;
  await withServer(pool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/projects/mainty/sprints`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'sprint-5' }),
    });
    assert.equal(response.status, 409);
    assert.match((await response.json()).message, /gleicher Git-Branch/);
  });
});
