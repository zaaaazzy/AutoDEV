import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Router } from 'express';
import type { Pool } from 'pg';
import { registerDocRoutes } from './docs.js';

type Handler = (request: unknown, response: unknown) => Promise<void>;

test('POST /projects/:slug/docs überschreibt kein bestehendes Handbuch', async () => {
  const handlers = new Map<string, Handler>();
  const app = {
    post: (path: string, h: Handler) => handlers.set(`POST ${path}`, h),
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
