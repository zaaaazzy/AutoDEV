import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import type { Pool } from 'pg';
import type { Principal } from './roles.js';
import { requiredRole } from './route-table.test.js';
import { parseJobUpdate, registerScheduledJobRoutes } from './scheduled-jobs.js';

const admin: Principal = { id: null, username: 'admin', displayName: 'Admin', roles: ['admin'] };
const planner: Principal = { id: '1', username: 'ana', displayName: 'Ana', roles: ['plan', 'run', 'agents'] };

/** Router wie in app.ts, mit fest gesetztem Benutzer; die Datenbank merkt sich alle Anweisungen. */
async function withRoutes(
  principal: Principal | undefined,
  action: (baseUrl: string, queries: { sql: string; values: unknown[] }[]) => Promise<void>,
): Promise<void> {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.startsWith('SELECT')) return { rows: [{ key: 'backup_check', enabled: true }] };
      return { rows: values[0] === 'backup_check' ? [{ key: 'backup_check', intervalSeconds: values[2] }] : [] };
    },
  } as unknown as Pool;
  const app = express();
  app.use(express.json());
  const api = express.Router();
  api.use((_request, response, next) => {
    response.locals.principal = principal;
    next();
  });
  registerScheduledJobRoutes(api, pool);
  app.use('/api', api);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    await action(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, queries);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const patch = (url: string, body: unknown) =>
  fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('Wartungs-Jobs: Nicht-Admins werden beim Lesen und Ändern serverseitig abgelehnt', async () => {
  for (const principal of [planner, undefined]) {
    await withRoutes(principal, async (baseUrl, queries) => {
      assert.equal((await fetch(`${baseUrl}/api/scheduled-jobs`)).status, 403);
      assert.equal((await patch(`${baseUrl}/api/scheduled-jobs/backup_check`, { enabled: false })).status, 403);
      assert.deepEqual(queries, [], 'keine Datenbankabfrage ohne Rolle');
    });
  }
  assert.equal(requiredRole('PATCH', '/api/scheduled-jobs/backup_check', {}), 'admin');
  assert.equal(requiredRole('POST', '/api/scheduled-jobs', {}), 'admin');
});

test('Wartungs-Jobs: Administratoren lesen Jobs samt erlaubten Job-Arten', async () => {
  await withRoutes(admin, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/scheduled-jobs`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { jobs: unknown[]; kinds: string[] };
    assert.equal(body.jobs.length, 1);
    assert.deepEqual(body.kinds.sort(), [
      'backup_check',
      'bug_categories',
      'close_old_sprints',
      'push_alert',
      'restore_probe',
      'watchdog_logs',
    ]);
  });
});

test('Wartungs-Jobs: PATCH ändert Aktiv-Flag, Intervall, Startzeit und Konfiguration und taktet neu', async () => {
  await withRoutes(admin, async (baseUrl, queries) => {
    const response = await patch(`${baseUrl}/api/scheduled-jobs/backup_check`, {
      enabled: true,
      intervalSeconds: 120,
      startAt: '2026-10-21T06:00:00+02:00',
      config: { maxAgeHours: 30 },
    });
    assert.equal(response.status, 200);
    const { sql, values } = queries[0]!;
    assert.deepEqual(values, ['backup_check', true, 120, '2026-10-21T04:00:00.000Z', '{"maxAgeHours":30}']);
    assert.match(sql, /next_run_at = CASE WHEN \$3::integer IS NULL AND \$4::timestamptz IS NULL THEN next_run_at/);
    assert.match(sql, /last_run_at \+ make_interval\(secs => COALESCE\(\$3::integer, interval_seconds\)\)/);
    assert.equal((await patch(`${baseUrl}/api/scheduled-jobs/unbekannt`, { enabled: true })).status, 404);
    assert.equal((await patch(`${baseUrl}/api/scheduled-jobs/..%2Fx`, { enabled: true })).status, 404);
    assert.equal((await patch(`${baseUrl}/api/scheduled-jobs/backup_check`, { intervalSeconds: 5 })).status, 400);
  });
});

test('parseJobUpdate prüft jedes Feld; die Job-Art lässt sich nicht ändern', () => {
  assert.equal(parseJobUpdate(null), 'Ungültige Angaben.');
  assert.equal(parseJobUpdate({}), 'Keine Änderung angegeben.');
  assert.equal(parseJobUpdate({ kind: 'shell' }), 'Keine Änderung angegeben.');
  assert.match(parseJobUpdate({ enabled: 'ja' }) as string, /enabled/);
  assert.match(parseJobUpdate({ intervalSeconds: 59 }) as string, /Intervall/);
  assert.match(parseJobUpdate({ intervalSeconds: 90.5 }) as string, /Intervall/);
  assert.match(parseJobUpdate({ intervalSeconds: 31 * 24 * 3600 }) as string, /Intervall/);
  assert.match(parseJobUpdate({ startAt: 'morgen' }) as string, /Startzeit/);
  assert.match(parseJobUpdate({ config: [] }) as string, /JSON-Objekt/);
  assert.match(parseJobUpdate({ config: { text: 'x'.repeat(5000) } }) as string, /höchstens/);
  assert.deepEqual(parseJobUpdate({ enabled: false }), {
    enabled: false,
    intervalSeconds: null,
    startAt: null,
    config: null,
  });
});
