import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import type { Pool } from 'pg';
import { access, findRoute, routeGuard, routeTable } from './access.js';
import { registerReviewRoutes } from './review-routes.js';
import type { Principal } from './roles.js';
import { apiRoutes } from './route-table.test.js';
import { isEntity } from './tenancy.js';

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Ausdrücklich projektübergreifende Routen. Wer hier ergänzt, prüft, dass die Route selbst nach Projekten filtert. */
const GLOBAL = new Set([
  'GET /session',
  'POST /login',
  'POST /logout',
  'GET /auth/status',
  'POST /auth/totp/setup',
  'POST /auth/totp/enable',
  'POST /auth/totp/disable',
  'POST /auth/logout-others',
  'GET /push/key',
  'POST /push/subscribe',
  'POST /push/unsubscribe',
  'POST /push/test',
  'GET /projects',
  'GET /agent-status',
  'GET /setup/templates',
  'GET /setup/scope',
  'GET /setup/permissions',
  'GET /system-agents',
  'GET /settings',
  'GET /review-slots',
  'POST /review-slots/:slot/stop',
  // Ideen kommen im Body; die Abfragen filtern nach allowedProjects.
  'POST /ideation/bulk/reject',
  'POST /ideation/bulk/priority',
]);

test('Jede registrierte API-Route deklariert Rolle und Mandanten', () => {
  const routes = apiRoutes();
  assert.ok(routes.length > 100, `nur ${routes.length} Routen gefunden – liest der Test den Router noch richtig?`);
  const undeclared = routes.filter((route) => !route.access).map((route) => `${route.method} ${route.path}`);
  assert.deepEqual(undeclared, [], 'Routen ohne access({...})');
  // Schreibende Routen nennen ihre Rolle ausdrücklich (auch null = jeder Angemeldete), statt still Administration
  // zu erben.
  const withoutRole = routes
    .filter((route) => WRITES.has(route.method) && route.access?.role === undefined)
    .map((route) => `${route.method} ${route.path}`);
  assert.deepEqual(withoutRole, [], 'schreibende Routen ohne role');
});

test('Jede Route prüft ihren Mandanten passend zum Pfad', () => {
  const wrong: string[] = [];
  for (const route of apiRoutes()) {
    const key = `${route.method} ${route.path}`;
    const tenant = route.access?.tenant;
    const first = route.path.split('/')[1]!;
    // Der Wächter versteht nur feste Teile und :parameter; alles andere träfe nie (und bliebe Administratoren).
    if (!route.match(route.path.replace(/:\w+/g, 'x'))) wrong.push(`${key}: Pfad nicht auswertbar`);
    if (route.path.startsWith('/projects/:slug')) {
      if (tenant !== 'project') wrong.push(`${key}: ${tenant} statt project`);
    } else if (isEntity(first) && route.path.startsWith(`/${first}/:id`)) {
      if (tenant !== first) wrong.push(`${key}: ${tenant} statt ${first}`);
    } else if (GLOBAL.has(key)) {
      if (tenant !== 'global') wrong.push(`${key}: ${tenant} statt global`);
    } else if (tenant !== 'admin') {
      wrong.push(`${key}: ${tenant} – nicht zuordenbar, also admin (oder bewusst in GLOBAL aufnehmen)`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('Review-Container: Rechte stehen an den Routen (Freigeben Administration, Starten/Beenden Ausführen)', () => {
  const declared = (key: string) => apiRoutes().find((route) => `${route.method} ${route.path}` === key)?.access;
  assert.deepEqual(declared('PUT /review-slots/:slot'), { role: 'admin', tenant: 'admin' });
  assert.deepEqual(declared('POST /review-slots/:slot/stop'), { role: 'run', tenant: 'global' });
  assert.deepEqual(declared('POST /projects/:slug/review-slots/start'), { role: 'run', tenant: 'project' });
  assert.deepEqual(declared('GET /review-slots'), { tenant: 'global' });
});

const MEMBER = '2d6f1c7e-1d2a-4c3b-9e8f-112233445566';
const OWN_ORDER = '0b6f1c7e-1d2a-4c3b-9e8f-112233445566';
const FOREIGN_ORDER = '1c6f1c7e-1d2a-4c3b-9e8f-112233445566';

/** API mit Wächter wie im Betrieb; der Benutzer ist Mitglied von „alpha“, Slot 2 gehört „beta“. */
async function withGuardedApi(
  principal: Principal,
  extra: (router: express.Router) => void,
  action: (url: string, queries: { sql: string; values: unknown[] }[]) => Promise<void>,
): Promise<void> {
  const queries: { sql: string; values: unknown[] }[] = [];
  const slots = [
    { slot: 1, status: 'running', projectSlug: 'alpha' },
    { slot: 2, status: 'running', projectSlug: 'beta' },
  ];
  const orders: Record<string, string> = { [OWN_ORDER]: 'alpha', [FOREIGN_ORDER]: 'beta' };
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('project_members')) return { rows: [{ slug: 'alpha' }], rowCount: 1 };
      if (sql.startsWith('SELECT 1 FROM development_items')) {
        const hit = orders[values[0] as string] === values[1];
        return { rows: hit ? [{}] : [], rowCount: hit ? 1 : 0 };
      }
      if (sql.startsWith("UPDATE review_slots SET status = 'stopping'")) {
        const allowed = values[1] as string[] | null;
        const hit = slots.find((slot) => slot.slot === values[0] && (!allowed || allowed.includes(slot.projectSlug)));
        return { rows: [], rowCount: hit ? 1 : 0 };
      }
      if (sql.startsWith('UPDATE review_slots')) return { rows: [{ slot: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const app = express();
  app.use(express.json());
  const router = express.Router({ caseSensitive: true });
  router.use((_request, response, next) => {
    response.locals.principal = principal;
    next();
  });
  router.use(routeGuard(pool, router));
  registerReviewRoutes(router, pool);
  extra(router);
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    await action(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, queries);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const post = (url: string, body: unknown = {}, method = 'POST') =>
  fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const runner: Principal = { id: MEMBER, username: 'rita', displayName: 'Rita', roles: ['run'] };

test('Rolle „Ausführen“ beendet Review-Container des eigenen Projekts, fremde nicht, Freigeben nie', async () => {
  await withGuardedApi(
    runner,
    () => undefined,
    async (url) => {
      assert.equal((await post(`${url}/api/review-slots/1/stop`)).status, 200);
      assert.equal((await post(`${url}/api/review-slots/2/stop`)).status, 409, 'Slot eines anderen Mandanten');
      assert.equal((await post(`${url}/api/review-slots/1`, { enabled: false }, 'PUT')).status, 403);
    },
  );
  const planner: Principal = { ...runner, roles: ['plan'] };
  await withGuardedApi(
    planner,
    () => undefined,
    async (url) => {
      assert.equal((await post(`${url}/api/review-slots/1/stop`)).status, 403, 'ohne Ausführen kein Stopp');
    },
  );
});

test('Review-Start: ein Auftrag aus einem fremden Projekt übernimmt keinen Container', async () => {
  const commit = 'a'.repeat(40);
  await withGuardedApi(
    runner,
    () => undefined,
    async (url, queries) => {
      const foreign = await post(`${url}/api/projects/alpha/review-slots/start`, {
        commit,
        developmentId: FOREIGN_ORDER,
      });
      assert.equal(foreign.status, 404);
      assert.ok(!queries.some((query) => query.sql.startsWith('UPDATE review_slots')), 'kein Slot angefordert');
      const own = await post(`${url}/api/projects/alpha/review-slots/start`, { commit, developmentId: OWN_ORDER });
      assert.equal(own.status, 200);
      const update = queries.find((query) => query.sql.startsWith('UPDATE review_slots'));
      assert.deepEqual(update?.values.slice(0, 1), ['alpha']);
      assert.equal(update?.values[3], OWN_ORDER);
      // Fremdes Projekt im Pfad: nicht gefunden, bevor die Route läuft.
      assert.equal((await post(`${url}/api/projects/beta/review-slots/start`, { commit })).status, 404);
    },
  );
});

test('Undeklarierte Route und Pfad ohne Route: nur Administration (fail-closed)', async () => {
  const everything: Principal = {
    ...runner,
    roles: ['agents', 'run', 'plan', 'docs', 'editor', 'chat'],
  };
  const extra = (router: express.Router) => {
    router.post('/neu', (_request, response) => void response.json({ ok: true }));
    router.get('/neu', (_request, response) => void response.json({ ok: true }));
    router.get('/deklariert', access({ tenant: 'global' }), (_request, response) => void response.json({ ok: true }));
  };
  await withGuardedApi(everything, extra, async (url) => {
    assert.equal((await post(`${url}/api/neu`)).status, 403);
    assert.equal((await fetch(`${url}/api/neu`)).status, 403);
    assert.equal((await post(`${url}/api/gibt-es-nicht`)).status, 403);
    assert.equal((await fetch(`${url}/api/deklariert`)).status, 200);
  });
  const admin: Principal = { id: null, username: 'admin', displayName: 'Admin', roles: ['admin'] };
  await withGuardedApi(admin, extra, async (url) => {
    assert.equal((await post(`${url}/api/neu`)).status, 200);
  });
});

test('Schrägstrich am Pfadende: Wächter und Router wählen dieselbe Route (mit und ohne strict)', async () => {
  const declaration = access({ role: 'run', tenant: 'development' });
  for (const strict of [false, true]) {
    const router = express.Router({ caseSensitive: true, strict });
    router.patch('/development/:id', declaration, (_request, response) => void response.json({ route: true }));
    const table = routeTable(router);
    const guard = (path: string) => findRoute(table, 'PATCH', path)?.entry.path;
    const app = express();
    app.use('/api', router);
    app.use((_request, response) => void response.status(404).json({ route: false }));
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
      for (const path of ['/development/x', '/development/x/', '/development/x//', '/Development/x']) {
        const reached = (await (await fetch(`${url}${path}`, { method: 'PATCH' })).json()).route as boolean;
        // Trifft Express die Route, muss der Wächter sie auch treffen (sonst gälte eine andere Rolle).
        assert.equal(guard(path) !== undefined, reached, `strict=${strict} ${path}`);
      }
      assert.equal(guard('/development/x/'), strict ? undefined : '/development/:id');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
