import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Pool } from 'pg';
import express from 'express';
import { createDevLogApp } from './app.js';
import { commitTitle, registerReviewRoutes, reviewCommits } from './review-routes.js';

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

/** „Im Review-Container prüfen“ für einen Auftrag im Status `status`; liefert Antwort und Slot-Anfrage. */
async function showReview(status: string) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.startsWith('UPDATE review_slots')) return { rows: [{ slot: 2 }], rowCount: 1 };
      if (sql.includes('FROM development_items'))
        return { rows: [{ slug: 'dev-log', title: 'Login', status }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const server = createDevLogApp(pool, null).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${port}/api/development/11111111-1111-4111-8111-111111111111/show-review`,
      { method: 'POST' },
    );
    return { status: response.status, update: queries.find((query) => query.sql.startsWith('UPDATE review_slots')) };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('Review-Container für die Abnahme: erledigter Auftrag startet ohne festen Stand (Worker wählt ihn)', async () => {
  const result = await showReview('done');
  assert.equal(result.status, 200);
  assert.ok(result.update);
  assert.deepEqual(result.update.values, [
    'dev-log',
    null,
    'Abnahme: Login',
    '11111111-1111-4111-8111-111111111111',
    'manual',
  ]);
});

test('Review-Container: Auftrag in Freigabe bleibt eine Freigabe', async () => {
  const result = await showReview('approval');
  assert.equal(result.status, 200);
  assert.equal(result.update?.values[4], 'approval');
  assert.equal(result.update?.values[2], 'Freigabe: Login');
});

test('Review-Container: laufender Auftrag wird abgelehnt', async () => {
  const result = await showReview('in_progress');
  assert.equal(result.status, 409);
  assert.equal(result.update, undefined);
});

test('Review-Container: manueller Start bevorzugt einen freien Container vor einer laufenden Freigabe', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return { rows: sql.startsWith('UPDATE review_slots') ? [{ slot: 2 }] : [], rowCount: 1 };
    },
  } as unknown as Pool;
  const server = createDevLogApp(pool, null).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    await fetch(`http://127.0.0.1:${port}/api/projects/dev-log/review-slots/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commit: 'c'.repeat(40) }),
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const update = queries.find((query) => query.sql.startsWith('UPDATE review_slots'));
  assert.ok(update);
  const order = update.sql.slice(update.sql.indexOf('ORDER BY'));
  // Derselbe Auftrag, dann der eigene manuelle Container, dann ein freier – eine Freigabe kommt zuletzt dran.
  assert.ok(order.indexOf("kind = 'manual'") < order.indexOf("(status = 'idle') DESC"));
  assert.ok(order.indexOf("(status = 'idle') DESC") < order.indexOf("kind = 'approval') ASC"));
  assert.doesNotMatch(order, /\(project_slug IS NOT DISTINCT FROM \$1\) DESC/);
});

test('Kopfzeile: Stände mit Auftragsname, laufender Sprint zuerst, jeder Commit nur einmal', () => {
  const commits = reviewCommits(
    [
      {
        id: 's9',
        name: 'Sprint 9',
        status: 'active',
        commits: [
          {
            hash: 'a'.repeat(40),
            subject: 'Projektcode filtern (noch nicht im Sprint)',
            date: '2026-10-21T21:00:00+02:00',
            developmentId: '11111111-1111-4111-8111-111111111111',
            merged: false,
          },
          {
            hash: 'b'.repeat(40),
            subject: 'Merge auftrag/22222222-ci-e2e: CI: E2E-Tests',
            date: '2026-10-21T20:00:00+02:00',
            developmentId: null,
            merged: true,
          },
        ],
      },
      {
        id: 's8',
        name: 'Sprint 8',
        status: 'completed',
        commits: [
          { hash: 'b'.repeat(40), subject: 'doppelt', date: '', developmentId: null, merged: true },
          {
            hash: 'c'.repeat(40),
            subject: 'chore(Sprint 8): Sprint-Stand sichern',
            date: '',
            developmentId: null,
            merged: true,
          },
        ],
      },
    ],
    new Map([
      ['11111111-1111-4111-8111-111111111111', { title: 'Projektcode nur gefiltert ausführen', status: 'approval' }],
    ]),
  );
  assert.deepEqual(
    commits.map((commit) => [commit.hash[0], commit.title, commit.sprintName, commit.orderStatus]),
    [
      ['a', 'Projektcode nur gefiltert ausführen', 'Sprint 9', 'approval'],
      ['b', 'CI: E2E-Tests', 'Sprint 9', null],
      ['c', 'chore(Sprint 8): Sprint-Stand sichern', 'Sprint 8', null],
    ],
  );
  assert.equal(commitTitle("Merge branch 'auftrag/3fb09133-verwaiste' into sprint/sprint-9"), '');
});

test('Kopfzeile: GET review-commits liest nur Sprints des Projekts und keine geplanten', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('FROM sprints s JOIN sprint_commits')) {
        return {
          rows: [
            {
              id: 's9',
              name: 'Sprint 9',
              status: 'active',
              commits: [
                {
                  hash: 'a'.repeat(40),
                  subject: 'x',
                  date: '',
                  developmentId: '11111111-1111-4111-8111-111111111111',
                  merged: true,
                },
              ],
            },
          ],
        };
      }
      if (sql.includes('FROM development_items')) {
        return { rows: [{ id: '11111111-1111-4111-8111-111111111111', title: 'Login', status: 'done' }] };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const app = express();
  const router = express.Router();
  registerReviewRoutes(router, pool);
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const body = (await (await fetch(`${url}/api/projects/dev-log/review-commits`)).json()) as {
      commits: { title: string; sprintName: string }[];
    };
    assert.deepEqual(
      body.commits.map((commit) => [commit.title, commit.sprintName]),
      [['Login', 'Sprint 9']],
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const sprints = queries.find((query) => query.sql.includes('FROM sprints s JOIN sprint_commits'));
  assert.match(sprints?.sql ?? '', /s\.project_slug = \$1 AND s\.status <> 'planned'/);
  assert.deepEqual(sprints?.values, ['dev-log']);
  const orders = queries.find((query) => query.sql.includes('FROM development_items'));
  assert.match(orders?.sql ?? '', /project_slug = \$1/);
});
