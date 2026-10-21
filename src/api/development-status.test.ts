import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Pool } from 'pg';
import { createDevLogApp } from './app.js';

const ID = '11111111-1111-4111-8111-111111111111';
const SPRINT = '22222222-2222-4222-8222-222222222222';

/** Pool-Attrappe: jede Abfrage sieht einen Auftrag im Status `current` und einen Sprint im Status `sprintStatus`. */
async function patch(current: string, body: Record<string, unknown>, sprintStatus = 'active') {
  const queries: string[] = [];
  const row = { id: ID, status: current, projectSlug: 'dev-log', sprintStatus, sprint_status: sprintStatus, 1: 1 };
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [row], rowCount: 1 };
    },
  } as unknown as Pool;
  const server = createDevLogApp(pool, null).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/development/${ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, queries };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

for (const [from, to] of [
  ['planned', 'done'],
  ['backlog', 'done'],
  ['planned', 'approval'],
  ['planned', 'in_progress'],
  ['backlog', 'in_progress'],
  ['in_progress', 'backlog'],
  ['in_progress', 'planned'],
  ['done', 'planned'],
]) {
  test(`PATCH /development: ${from} → ${to} wird mit 409 abgelehnt und nichts geschrieben`, async () => {
    const result = await patch(from, { status: to });
    assert.equal(result.status, 409);
    assert.ok(!result.queries.some((sql) => /^\s*UPDATE development_items/i.test(sql)));
  });
}

for (const [from, to] of [
  ['backlog', 'planned'],
  ['planned', 'backlog'],
  ['blocked', 'planned'],
  ['planned', 'rejected'],
]) {
  test(`PATCH /development: ${from} → ${to} bleibt erlaubt`, async () => {
    const result = await patch(from, { status: to });
    assert.equal(result.status, 200);
  });
}

test('PATCH /development: Zuordnung zu abgeschlossenem Sprint wird mit 409 abgelehnt', async () => {
  for (const sprintStatus of ['completed', 'review']) {
    const result = await patch('backlog', { sprintId: SPRINT }, sprintStatus);
    assert.equal(result.status, 409, `Sprint im Status ${sprintStatus}`);
    assert.ok(!result.queries.some((sql) => /^\s*UPDATE development_items/i.test(sql)));
  }
});

/** Folgeauftrag zu einem erledigten Auftrag, Ziel-Sprint im Status `sprintStatus`. */
async function followUp(sprintStatus: string) {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (/FROM sprints/.test(sql)) return { rows: [{ status: sprintStatus }], rowCount: 1 };
      return { rows: [{ id: ID, status: 'done', projectSlug: 'dev-log', title: 'Login' }], rowCount: 1 };
    },
  } as unknown as Pool;
  const server = createDevLogApp(pool, null).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/development/${ID}/follow-up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Nachtrag', description: 'Rest', sprintId: SPRINT }),
    });
    return { status: response.status, queries };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('Folgeauftrag: abgeschlossener Sprint wird mit 409 abgelehnt und nichts angelegt', async () => {
  const result = await followUp('completed');
  assert.equal(result.status, 409);
  assert.ok(!result.queries.some((sql) => /INSERT INTO development_items/i.test(sql)));
});

test('Folgeauftrag: aktiver Sprint bleibt erlaubt', async () => {
  const result = await followUp('active');
  assert.notEqual(result.status, 409);
  assert.ok(result.queries.some((sql) => /INSERT INTO development_items/i.test(sql)));
});

/** Auftrag aus dem Sprint nehmen; liefert die UPDATE-Abfrage. */
async function removeFromSprint() {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [{ id: ID, status: 'backlog', projectSlug: 'dev-log' }], rowCount: 1 };
    },
  } as unknown as Pool;
  const server = createDevLogApp(pool, null).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/development/${ID}/remove-from-sprint`, {
      method: 'POST',
    });
    return { status: response.status, update: queries.find((sql) => /UPDATE development_items/.test(sql)) ?? '' };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('Aus dem Sprint nehmen: nur aus laufenden Sprints mit Vermerk (Karte unter „Aktionen“), aus geplanten ohne', async () => {
  const result = await removeFromSprint();
  assert.equal(result.status, 200);
  // Der Vermerk hängt am Sprint-Status: geplant = reine Planung, kein Vermerk.
  assert.match(
    result.update,
    /removed_from_sprint = \(SELECT name FROM sprints WHERE id = development_items\.sprint_id AND status <> 'planned'\)/,
  );
  assert.match(result.update, /= 'planned'\s+THEN NULL ELSE NOW\(\) END/);
});
