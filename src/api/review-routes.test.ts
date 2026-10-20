import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Pool } from 'pg';
import express from 'express';
import { createDevLogApp } from './app.js';
import { registerReviewRoutes } from './review-routes.js';

/** Nummern der Platzhalter ($1, $2, …), die eine Abfrage verwendet. */
function placeholders(sql: string): number[] {
  return [...new Set([...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))].sort((a, b) => a - b);
}

test('Version starten (Sprint-Ansicht): die Abfrage nutzt genau die übergebenen Werte, in der richtigen Reihenfolge', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return { rows: sql.startsWith('UPDATE review_slots') ? [{ slot: 1 }] : [], rowCount: 1 };
    },
  } as unknown as Pool;
  const server = createDevLogApp(pool, null).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const commit = 'a'.repeat(40);
    const response = await fetch(`http://127.0.0.1:${port}/api/projects/dev-log/review-slots/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commit, label: 'Sprint 2' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { slot: 1 });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const update = queries.find((query) => query.sql.startsWith('UPDATE review_slots'));
  assert.ok(update);
  // Ein unbenutzter Platzhalter scheitert in Postgres mit „could not determine data type of parameter $1“.
  assert.deepEqual(
    placeholders(update.sql),
    update.values.map((_value, index) => index + 1),
  );
  assert.match(update.sql, /project_slug = \$1\b/);
  assert.match(update.sql, /commit_sha = \$2\b/);
  assert.deepEqual(update.values.slice(0, 3), ['dev-log', 'a'.repeat(40), 'Sprint 2']);
});

test('Review-Container: Nicht-Admins sehen nur Slots ihrer Projekte und stoppen nur diese', async () => {
  const slots = [
    { slot: 1, enabled: true, status: 'running', projectSlug: 'alpha', label: 'Sprint 1', commit: 'a'.repeat(40) },
    { slot: 2, enabled: true, status: 'running', projectSlug: 'beta', label: 'Geheim', commit: 'b'.repeat(40) },
  ];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('FROM review_slots')) return { rows: slots.map((slot) => ({ ...slot })) };
      if (sql.startsWith('UPDATE review_slots')) {
        const allowed = values[1] as string[] | null;
        const hit = slots.find((slot) => slot.slot === values[0] && (!allowed || allowed.includes(slot.projectSlug)));
        return { rows: [], rowCount: hit ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const app = express();
  app.use(express.json());
  // Wie der Mandantenwächter: freigeschaltete Projekte des Benutzers.
  app.use((_request, response, next) => {
    response.locals.allowedProjects = new Set(['alpha']);
    next();
  });
  const router = express.Router();
  registerReviewRoutes(router, pool);
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const list = (await (await fetch(`${url}/api/review-slots`)).json()) as {
      slots: { slot: number; projectSlug: string | null; label: string }[];
    };
    assert.equal(list.slots[0]?.projectSlug, 'alpha');
    assert.equal(list.slots[1]?.projectSlug, null);
    assert.notEqual(list.slots[1]?.label, 'Geheim');
    assert.equal((await fetch(`${url}/api/review-slots/1/stop`, { method: 'POST' })).status, 200);
    assert.equal((await fetch(`${url}/api/review-slots/2/stop`, { method: 'POST' })).status, 409);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
