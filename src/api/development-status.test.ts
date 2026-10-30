import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import type { Pool } from 'pg';
import { routeGuard } from './access.js';
import { createDevLogApp } from './app.js';
import { registerDevelopmentRoutes } from './development.js';
import type { Principal, Role } from './roles.js';

const ID = '11111111-1111-4111-8111-111111111111';
const SPRINT = '22222222-2222-4222-8222-222222222222';

/**
 * Pool-Attrappe: jede Abfrage sieht einen Auftrag im Status `current` (zugeordnet zu `currentSprintId`) und einen
 * Sprint im Status `sprintStatus`.
 */
async function patch(
  current: string,
  body: Record<string, unknown>,
  sprintStatus = 'active',
  currentSprintId: string | null = null,
) {
  const queries: string[] = [];
  const row = {
    id: ID,
    status: current,
    sprintId: currentSprintId,
    projectSlug: 'dev-log',
    sprintStatus,
    sprint_status: sprintStatus,
    1: 1,
  };
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

const OTHER_SPRINT = '33333333-3333-4333-8333-333333333333';
const isUpdate = (sql: string) => /^\s*UPDATE development_items/i.test(sql);

for (const status of ['in_progress', 'approval', 'done']) {
  test(`PATCH /development: Auftrag ${status} lässt sich nicht in einen anderen Sprint hängen (409, nichts geschrieben)`, async () => {
    const moved = await patch(status, { sprintId: OTHER_SPRINT }, 'planned', SPRINT);
    assert.equal(moved.status, 409);
    assert.ok(!moved.queries.some(isUpdate));
  });

  test(`PATCH /development: Auftrag ${status} lässt sich nicht aus dem Sprint lösen („Kein Sprint“, 409)`, async () => {
    const cleared = await patch(status, { sprintId: null }, 'active', SPRINT);
    assert.equal(cleared.status, 409);
    assert.ok(!cleared.queries.some(isUpdate));
  });

  test(`PATCH /development: Auftrag ${status} ohne Sprint lässt sich keinem Sprint zuordnen (409)`, async () => {
    const assigned = await patch(status, { sprintId: SPRINT }, 'planned', null);
    assert.equal(assigned.status, 409);
    assert.ok(!assigned.queries.some(isUpdate));
  });

  test(`PATCH /development: Auftrag ${status} mit unverändertem Sprint speichert andere Felder weiter`, async () => {
    const same = await patch(status, { title: 'Neuer Titel', sprintId: SPRINT }, 'active', SPRINT);
    assert.equal(same.status, 200);
    assert.ok(same.queries.some(isUpdate));
  });
}

test('PATCH /development: erledigter Auftrag im abgeschlossenen Sprint bleibt mit unverändertem Sprint speicherbar', async () => {
  const result = await patch('done', { title: 'Neuer Titel', sprintId: SPRINT }, 'completed', SPRINT);
  assert.equal(result.status, 200);
});

test('PATCH /development: Sperre greift vor der Prüfung des Ziel-Sprints', async () => {
  // Ziel-Sprint wäre zulässig (aktiv); abgelehnt wird allein wegen des laufenden Auftrags.
  const result = await patch('in_progress', { sprintId: OTHER_SPRINT }, 'active', SPRINT);
  assert.equal(result.status, 409);
  assert.ok(!result.queries.some((sql) => /FROM sprints/.test(sql)));
});

test('PATCH /development: geplanter Auftrag lässt sich weiter umhängen, atomar gegen Statuswechsel', async () => {
  const result = await patch('planned', { sprintId: OTHER_SPRINT }, 'planned', SPRINT);
  assert.equal(result.status, 200);
  assert.match(result.queries.find(isUpdate) ?? '', /AND status = ANY\(/);
});

test('Aus dem Sprint nehmen: Auftrags- und Sprint-Status in derselben Abfrage (Positivliste)', async () => {
  const result = await removeFromSprint();
  assert.match(result.update, /status IN \('backlog', 'planned', 'blocked'\)/);
  assert.match(
    result.update,
    /EXISTS \(SELECT 1 FROM sprints s WHERE s\.id = development_items\.sprint_id\s+AND s\.status IN \('planned', 'active'\)\)/,
  );
});

for (const itemStatus of ['approval', 'rejected', 'in_progress', 'done']) {
  test(`Aus dem Sprint nehmen: Auftrag im Status ${itemStatus} wird mit 409 abgelehnt`, async () => {
    const result = await removeFromSprint(itemStatus, 'active');
    assert.equal(result.status, 409);
  });
}

for (const sprintStatus of ['review', 'completed', 'cancelled']) {
  test(`Aus dem Sprint nehmen: Sprint im Status ${sprintStatus} wird mit 409 abgelehnt`, async () => {
    const result = await removeFromSprint('planned', sprintStatus);
    assert.equal(result.status, 409);
  });
}

for (const itemStatus of ['planned', 'blocked', 'backlog']) {
  test(`Aus dem Sprint nehmen: Auftrag im Status ${itemStatus} aus aktivem Sprint bleibt erlaubt`, async () => {
    const result = await removeFromSprint(itemStatus, 'active');
    assert.equal(result.status, 200);
  });
}

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

/**
 * Auftrag im Status `itemStatus` aus einem Sprint im Status `sprintStatus` nehmen; liefert Status und UPDATE-Abfrage.
 * Das UPDATE liefert nur eine Zeile, wenn beide Status passen (wie die WHERE-Bedingung in Postgres).
 */
async function removeFromSprint(itemStatus = 'planned', sprintStatus = 'active') {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      const fits =
        ['backlog', 'planned', 'blocked'].includes(itemStatus) && ['planned', 'active'].includes(sprintStatus);
      return fits
        ? { rows: [{ id: ID, status: 'backlog', projectSlug: 'dev-log' }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
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

/**
 * „In Sprint übernehmen“ gegen eine Pool-Attrappe: Auftrag im Status `itemStatus`, Ziel-Sprint im Status
 * `sprintStatus`. Das UPDATE liefert nur eine Zeile, wenn beide Status passen (wie die WHERE-Bedingung in Postgres).
 */
async function takeIntoSprint(itemStatus: string, sprintStatus: string, sprintId: string = SPRINT) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      // Meldung nach abgelehntem UPDATE: Sprint im Projekt des Auftrags (fremde Sprints: tenant-ids.test.ts).
      if (sql.includes('FROM sprints s JOIN development_items d')) {
        return { rows: [{ status: sprintStatus }], rowCount: 1 };
      }
      const fits =
        ['backlog', 'planned', 'blocked'].includes(itemStatus) && ['planned', 'active'].includes(sprintStatus);
      return fits ? { rows: [{ id: ID, status: 'planned', sprintId }], rowCount: 1 } : { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const server = createDevLogApp(pool, null).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/development/${ID}/take-into-sprint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sprintId }),
    });
    return {
      status: response.status,
      updates: queries.filter((query) => /^\s*UPDATE development_items/i.test(query.sql)),
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('In Sprint übernehmen: abgebrochener Auftrag in geplantem Sprint startet nicht und hängt nie am aktiven Sprint', async () => {
  const result = await takeIntoSprint('blocked', 'planned');
  assert.equal(result.status, 200);
  // Genau ein UPDATE: kein Zwischenstand wie früher bei /retry und anschliessendem PATCH.
  assert.equal(result.updates.length, 1);
  const [update] = result.updates;
  // auto_run hängt am Ziel-Sprint: aktiv = sofort starten, geplant = warten, bis der Sprint startet.
  assert.match(
    update.sql,
    /auto_run = COALESCE\(\(SELECT s\.status = 'active' FROM sprints s WHERE s\.id = \$2\), FALSE\)/,
  );
  assert.doesNotMatch(update.sql, /auto_run = TRUE/);
  // Ein von Hand zugewiesener Agent liesse selectItems den Auftrag trotz geplantem Sprint starten.
  assert.match(update.sql, /agent_id = CASE WHEN [^]*? THEN NULL ELSE d\.agent_id END/);
  // Der Ziel-Sprint wird direkt gesetzt, der aktive Sprint wird nie nachgeschlagen.
  assert.match(update.sql, /sprint_id = \$2/);
  assert.equal(update.values[1], SPRINT);
  assert.doesNotMatch(update.sql, /status = 'active' ORDER BY/);
  // Sprint-Status und Projekt werden in derselben Abfrage geprüft (kein Wettlauf mit Abschluss oder Abbruch).
  assert.match(update.sql, /s\.project_slug = d\.project_slug\s+AND s\.status IN \('planned', 'active'\)/);
});

test('In Sprint übernehmen: selectItems startet geplante Aufträge nur im aktiven Sprint, per Hand oder mit auto_run ohne Sprint', async () => {
  const source = await readFile(new URL('../runner/runner-selection.ts', import.meta.url), 'utf8');
  // Mit agent_id = NULL bleibt ein Auftrag im geplanten Sprint liegen, auch mit auto_run (Verhalten auf PostgreSQL:
  // runner/sprint-requeue.test.ts).
  assert.match(
    source,
    /AND \(s\.status = 'active' OR d\.agent_id IS NOT NULL OR \(d\.auto_run AND d\.sprint_id IS NULL\)\)/,
  );
});

test('In Sprint übernehmen: aktiver Ziel-Sprint bleibt erlaubt', async () => {
  const result = await takeIntoSprint('backlog', 'active');
  assert.equal(result.status, 200);
  assert.equal(result.updates.length, 1);
});

for (const sprintStatus of ['completed', 'cancelled', 'review']) {
  test(`In Sprint übernehmen: Ziel-Sprint im Status ${sprintStatus} wird mit 409 abgelehnt`, async () => {
    assert.equal((await takeIntoSprint('blocked', sprintStatus)).status, 409);
  });
}

for (const itemStatus of ['in_progress', 'done', 'approval', 'rejected']) {
  test(`In Sprint übernehmen: Auftrag im Status ${itemStatus} wird mit 409 abgelehnt`, async () => {
    assert.equal((await takeIntoSprint(itemStatus, 'planned')).status, 409);
  });
}

test('In Sprint übernehmen: ungültige Sprint-ID ergibt 400 ohne Schreibzugriff', async () => {
  const result = await takeIntoSprint('blocked', 'planned', 'kein-sprint');
  assert.equal(result.status, 400);
  assert.equal(result.updates.length, 0);
});

const ABORTED_NEEDS_RUN =
  /AND \(\$3::boolean OR NOT \(d\.removed_from_sprint_at IS NOT NULL OR d\.status = 'blocked'\)\)/;

/**
 * „In Sprint übernehmen“ mit Wächter wie im Betrieb, als Benutzer mit `roles` (Mitglied von dev-log). Die Attrappe
 * wertet nur die neue Bedingung aus: abgebrochene Aufträge gehen nur mit $3 (= darf ausführen) durch.
 */
async function takeAs(roles: Role[], aborted: boolean) {
  const updates: unknown[][] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('project_members') || sql.startsWith('SELECT project_slug AS slug FROM development_items')) {
        return { rows: [{ slug: 'dev-log' }], rowCount: 1 };
      }
      if (/^\s*UPDATE development_items/i.test(sql)) {
        updates.push(values);
        assert.match(sql, ABORTED_NEEDS_RUN);
        if (values[2] !== true && aborted) return { rows: [], rowCount: 0 };
        return { rows: [{ id: ID, status: 'planned', sprintId: SPRINT }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT 1 FROM development_items d')) return { rows: [], rowCount: aborted ? 1 : 0 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const principal: Principal = { id: ID, username: 'pia', displayName: 'Pia', roles };
  const app = express();
  app.use(express.json());
  const router = express.Router({ caseSensitive: true });
  router.use((_request, response, next) => {
    response.locals.principal = principal;
    next();
  });
  router.use(routeGuard(pool, router));
  registerDevelopmentRoutes(router, pool);
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/development/${ID}/take-into-sprint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sprintId: SPRINT }),
    });
    const { message } = (await response.json()) as { message?: string };
    return { status: response.status, message, updates };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('In Sprint übernehmen: abgebrochene Aufträge nur mit „Ausführen“ (wie /retry), offene schon mit „Planung“', async () => {
  const planner = await takeAs(['plan'], true);
  assert.equal(planner.status, 403);
  assert.match(planner.message ?? '', /Agents ausführen/);
  assert.equal(planner.updates[0]?.[2], false, 'ohne Ausführen schliesst das UPDATE Abgebrochene aus');
  assert.equal((await takeAs(['plan'], false)).status, 200, 'offener Auftrag mit Planung');
  assert.equal((await takeAs(['plan', 'run'], true)).status, 200, 'abgebrochener Auftrag mit Planung und Ausführen');
  assert.equal((await takeAs(['run'], false)).status, 403, 'ohne Planung gar nicht');
});

test('PATCH /development: Zuordnung zu geplantem Sprint nimmt auto_run zurück', async () => {
  const result = await patch('backlog', { sprintId: SPRINT }, 'planned');
  assert.equal(result.status, 200);
  assert.match(result.queries.find((sql) => /^\s*UPDATE development_items/i.test(sql)) ?? '', /auto_run = FALSE/);
});

test('PATCH /development: Zuordnung zu aktivem Sprint lässt auto_run unverändert', async () => {
  const result = await patch('backlog', { sprintId: SPRINT }, 'active');
  assert.equal(result.status, 200);
  assert.doesNotMatch(result.queries.find((sql) => /^\s*UPDATE development_items/i.test(sql)) ?? '', /auto_run/);
});
