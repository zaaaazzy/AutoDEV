import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express, { type Router } from 'express';
import type { Pool } from 'pg';
import { routeGuard } from './access.js';
import { registerDocRevisionRoutes } from './doc-revisions.js';
import { registerDocRoutes } from './docs.js';
import type { Principal } from './roles.js';

type Handler = (request: unknown, response: unknown) => Promise<void>;

test('POST /projects/:slug/docs überschreibt kein bestehendes Handbuch', async () => {
  const handlers = new Map<string, Handler>();
  const app = {
    // Letzter Handler: davor steht die Rechte-Deklaration (access).
    post: (path: string, ...chain: Handler[]) => handlers.set(`POST ${path}`, chain.at(-1)!),
    get() {},
    patch() {},
    delete() {},
  };
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [{ id: 'x', title: 'Handbuch', content: 'alt' }] };
    },
  };
  registerDocRoutes(app as unknown as Router, pool as unknown as Pool);
  const handler = handlers.get('POST /projects/:slug/docs');
  assert.ok(handler);
  let status = 0;
  const response = {
    status(code: number) {
      status = code;
      return response;
    },
    json() {},
    locals: {},
  };
  await handler({ params: { slug: 'demo' }, body: { title: 'Handbuch', content: 'neu' } }, response);
  assert.ok(
    !queries.some((sql) => /DO UPDATE/i.test(sql)),
    'POST darf bestehende Inhalte nicht per ON CONFLICT DO UPDATE ersetzen',
  );
  assert.ok(status === 201 || status === 409);
});

const DOC = '66666666-6666-4666-8666-666666666666';

test('PATCH /docs/:id eines Redakteurs ändert kein Dokument, Änderungen laufen über Revisionen', async () => {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('project_members')) return { rows: [{ slug: 'alpha' }], rowCount: 1 };
      if (sql.includes('FROM docs WHERE id = $1') && sql.includes('project_slug')) {
        return { rows: [{ slug: 'alpha' }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT title, content, kind FROM docs')) {
        return { rows: [{ title: 'Handbuch', content: 'alt', kind: 'manual' }], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO doc_revisions')) return { rows: [{ id: 'r', status: 'pending' }], rowCount: 1 };
      // Läuft die Route doch, liefert das UPDATE ein Dokument zurück (wie die echte Datenbank).
      if (/UPDATE docs/i.test(sql)) return { rows: [{ id: DOC, title: 'Handbuch', content: 'neu' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const editor: Principal = {
    id: '77777777-7777-4777-8777-777777777777',
    username: 'rea',
    displayName: 'Rea',
    roles: ['docs', 'editor'],
  };
  const app = express();
  app.use(express.json());
  const router = express.Router({ caseSensitive: true });
  router.use((_request, response, next) => {
    response.locals.principal = editor;
    next();
  });
  router.use(routeGuard(pool, router));
  registerDocRoutes(router, pool);
  registerDocRevisionRoutes(router, pool);
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/docs/${DOC}`;
    const send = (path: string, method: string) =>
      fetch(`${url}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Handbuch', content: 'neu' }),
      });

    const patch = await send('', 'PATCH');
    assert.ok([403, 404, 405].includes(patch.status), `PATCH wird abgewiesen (Status ${patch.status})`);
    assert.ok(!queries.some((sql) => /UPDATE docs/i.test(sql)), 'PATCH darf kein UPDATE docs auslösen');

    // Der reguläre Weg bleibt offen: Revision einreichen, freigeben muss jemand anderes.
    assert.equal((await send('/revisions', 'POST')).status, 201);
    assert.ok(queries.some((sql) => sql.startsWith('INSERT INTO doc_revisions')));
    assert.ok(!queries.some((sql) => /UPDATE docs/i.test(sql)), 'Einreichen ändert das Dokument nicht');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
