import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import type { Pool } from 'pg';
import { canRetryDevelopment, canTakeIntoSprint } from '../core/development-transitions.js';
import { createDevLogApp } from './app.js';
import { completeSprint } from './sprint-planning.js';
import { cancelSprint, registerSprintRoutes } from './sprints.js';

const SPRINT_ID = '22222222-2222-4222-8222-222222222222';

/** Datenbank-Attrappe: `previous` ist der Status vor dem PATCH; ein UPDATE liefert den neuen Stand zurück. */
async function patchSprint(previous: string, body: unknown) {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.startsWith('SELECT status')) return { rows: [{ status: previous }] };
      // completeSprint setzt den Status per eigenem UPDATE; das PATCH-UPDATE selbst (`SET status = $2 … WHERE status = ANY`)
      // fällt in den nächsten Zweig und liefert den neuen Stand.
      if (sql.includes("UPDATE sprints SET status = 'completed'")) return { rows: [] };
      if (sql.startsWith('UPDATE sprints SET')) {
        const status = (body as { status?: string }).status ?? previous;
        return { rows: [{ id: SPRINT_ID, status }] };
      }
      return { rows: [] };
    },
  };
  // Der Abschluss läuft auf einer eigenen Verbindung (Transaktion); hier dieselbe Attrappe.
  const db = Object.assign(pool, { connect: async () => Object.assign(pool, { release: () => undefined }) });
  const response = await sendPatch(db as unknown as Pool, body);
  return { status: response.status, queries };
}

async function sendPatch(pool: Pool, body: unknown) {
  const app = express();
  app.use(express.json());
  const api = express.Router();
  registerSprintRoutes(api, pool);
  app.use('/api', api);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sprints/${SPRINT_ID}`;
    const response = await fetch(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json().catch(() => null)) as unknown };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const startedSync = (queries: string[]) => queries.some((sql) => sql.includes("git_sync = 'pending'"));
const completed = (queries: string[]) => queries.some((sql) => sql.includes("SET status = 'completed'"));

test('Sprint-PATCH: Name und Ziel eines abgeschlossenen Sprints lösen keinen Git-Sync aus', async () => {
  for (const body of [{ name: 'Neuer Name' }, { goal: 'Neues Ziel' }]) {
    const { status, queries } = await patchSprint('completed', body);
    assert.equal(status, 200);
    assert.equal(startedSync(queries), false, 'kein git_sync = pending');
    assert.equal(completed(queries), false, 'completeSprint nicht erneut');
  }
});

test('Sprint-PATCH: erneutes status=completed auf abgeschlossenem Sprint löst nichts aus', async () => {
  const { queries } = await patchSprint('completed', { status: 'completed' });
  assert.equal(startedSync(queries), false);
});

test('Sprint-PATCH: Abschluss eines aktiven Sprints startet Bericht und Git-Sync', async () => {
  const { status, queries } = await patchSprint('active', { status: 'completed' });
  assert.equal(status, 200);
  assert.equal(completed(queries), true);
  assert.equal(startedSync(queries), true);
});

const stoppedAgents = (queries: string[]) => queries.some((sql) => sql.includes('cancel_requested = TRUE'));
const releasedOrders = (queries: string[]) =>
  queries.some(
    (sql) =>
      sql.includes('removed_from_sprint_at = NOW(), sprint_id = NULL') &&
      sql.includes("status = CASE WHEN status IN ('planned', 'approval') THEN 'backlog' ELSE status END") &&
      sql.includes("status NOT IN ('done', 'rejected')"),
  );

test('Sprint-PATCH: Abbrechen beendet laufende Agents und gibt offene Aufträge frei – ohne Git-Sync', async () => {
  for (const previous of ['planned', 'active']) {
    const { status, queries } = await patchSprint(previous, { status: 'cancelled' });
    assert.equal(status, 200, `aus ${previous}`);
    assert.equal(stoppedAgents(queries), true, 'laufende Schritte bekommen cancel_requested');
    assert.equal(releasedOrders(queries), true, 'offene Aufträge verlassen den Sprint mit Vermerk');
    assert.equal(startedSync(queries), false, 'kein git_sync = pending');
    assert.equal(completed(queries), false, 'kein Sprintabschluss');
  }
});

test('Sprint-PATCH: Abgeschlossene lassen sich nicht abbrechen, abgebrochene nur wieder planen', async () => {
  assert.equal((await patchSprint('completed', { status: 'cancelled' })).status, 409);
  assert.equal((await patchSprint('cancelled', { status: 'active' })).status, 409);
  assert.equal((await patchSprint('cancelled', { status: 'cancelled' })).status, 409);
  const { status, queries } = await patchSprint('cancelled', { status: 'planned' });
  assert.equal(status, 200);
  assert.equal(stoppedAgents(queries), false, 'Wieder planen bricht nichts ab');
});

interface OrderRow {
  id: string;
  status: string;
  sprintId: string | null;
  removedFromSprintAt: string | null;
  kind: string;
}

const statusList = (text: string | undefined): string[] =>
  (text ?? '').split(',').map((part) => part.trim().replace(/^'|'$/g, ''));

/**
 * Datenbank-Attrappe für Aufträge: wertet die Statuslisten aus dem SQL von cancelSprint, /retry und take-into-sprint
 * aus (CASE … THEN 'backlog', NOT IN, IN), damit der Test die tatsächlich geschriebenen Bedingungen prüft.
 */
function orderDb(rows: OrderRow[]) {
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('UPDATE development_items SET removed_from_sprint =')) {
      const keep = statusList(/status NOT IN \(([^)]*)\)/.exec(sql)?.[1]);
      const reset = /CASE WHEN status (?:= '(\w+)'|IN \(([^)]*)\)) THEN 'backlog'/.exec(sql);
      const toBacklog = reset?.[1] ? [reset[1]] : statusList(reset?.[2]);
      const hit = rows.filter((row) => row.sprintId === params[0] && !keep.includes(row.status));
      for (const row of hit) {
        Object.assign(row, { sprintId: null, removedFromSprintAt: TODAY });
        if (toBacklog.includes(row.status)) row.status = 'backlog';
      }
      return { rows: [], rowCount: hit.length };
    }
    const row = rows.find((candidate) => candidate.id === params[0]);
    const lists = [...sql.matchAll(/d\.status IN \(([^)]*)\)/g)].map((match) => statusList(match[1]));
    if (sql.includes('UPDATE development_items d SET') && row) {
      const isRetry = sql.includes('retry_count = retry_count');
      const allowed = isRetry
        ? (lists[0]?.includes(row.status) ?? false) ||
          (!!row.removedFromSprintAt && (lists[1]?.includes(row.status) ?? false))
        : !row.sprintId && (lists[0]?.includes(row.status) ?? false);
      if (row.kind === 'express' || !allowed) return { rows: [], rowCount: 0 };
      Object.assign(row, { status: 'planned', removedFromSprintAt: null, sprintId: isRetry ? null : params[1] });
      return { rows: [{ ...row }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { query } as unknown as Pool;
}

async function postOrder(pool: Pool, id: string, action: 'retry' | 'take-into-sprint') {
  const server = createDevLogApp(pool, null).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/development/${id}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(action === 'retry' ? {} : { sprintId: NEXT_SPRINT_ID }),
    });
    return response.status;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const NEXT_SPRINT_ID = '33333333-3333-4333-8333-333333333333';
const orderId = (n: number) => `4444444${n}-4444-4444-8444-444444444444`;

function cancelledSprintOrders(): OrderRow[] {
  return ['approval', 'in_progress', 'planned', 'backlog', 'blocked', 'done', 'rejected'].map((status, index) => ({
    id: orderId(index),
    status,
    sprintId: SPRINT_ID,
    removedFromSprintAt: null,
    kind: 'feature',
  }));
}

test('Sprint-Abbruch: jede angebotene Aktion für dessen Aufträge klappt ohne 409 (auch aus Freigabe)', async () => {
  for (const action of ['retry', 'take-into-sprint'] as const) {
    const rows = cancelledSprintOrders();
    const pool = orderDb(rows);
    await cancelSprint(pool, SPRINT_ID);
    const offered = action === 'retry' ? canRetryDevelopment : canTakeIntoSprint;
    const byStatus = new Map(cancelledSprintOrders().map((row, index) => [row.status, rows[index]!]));
    // Aus Freigabe: nicht ohne Sprint in Freigabe festhängen, sondern wie geplante zurück ins Backlog.
    assert.equal(byStatus.get('approval')!.status, 'backlog', 'Freigabe geht beim Abbruch ins Backlog');
    for (const status of ['approval', 'planned', 'backlog', 'blocked']) {
      assert.equal(offered(byStatus.get(status)!), true, `${action}: ${status} wird angeboten`);
    }
    // Laufender Auftrag: wird erst angeboten, wenn der Worker ihn nach dem Agent-Ende ins Backlog setzt.
    const running = byStatus.get('in_progress')!;
    assert.equal(offered(running), false, `${action}: laufender Auftrag wird nicht angeboten`);
    assert.equal(await postOrder(pool, running.id, action), 409, 'echter Konflikt bleibt 409');
    running.status = 'backlog'; // settleItem: leftItsSprint → Backlog
    assert.equal(offered(running), true);
    for (const row of rows.filter((candidate) => offered(candidate))) {
      assert.equal(await postOrder(pool, row.id, action), 200, `${action} für ${row.id} (${row.status})`);
    }
    // Erledigte bleiben beim Sprint und werden nicht angeboten; ein Aufruf bleibt ein echter Konflikt.
    const done = byStatus.get('done')!;
    assert.equal(done.sprintId, SPRINT_ID);
    assert.equal(offered(done), false);
    assert.equal(await postOrder(pool, done.id, action), 409);
  }
});

test('Oberfläche und /retry: laufende und Aufträge in Freigabe mit Vermerk bieten kein „Wieder einplanen“ an', () => {
  for (const status of ['approval', 'in_progress', 'done']) {
    const item = { status, kind: 'feature', removedFromSprintAt: TODAY, sprintId: null };
    assert.equal(canRetryDevelopment(item), false, status);
    assert.equal(canTakeIntoSprint(item), false, status);
  }
  assert.equal(canRetryDevelopment({ status: 'backlog', removedFromSprintAt: TODAY }), true);
  assert.equal(canRetryDevelopment({ status: 'backlog', removedFromSprintAt: null }), false);
  assert.equal(canRetryDevelopment({ status: 'blocked', kind: 'express' }), false);
});

// „Heute“ der simulierten Datenbank ist fest vorgegeben (21.10.2026), damit der Test nicht vom Kalender abhängt.
const TODAY = '2026-10-21';
const FUTURE_START = '2026-11-01';

interface SprintRow {
  status: string;
  startDate: string | null;
  endDate: string | null;
  gitSync: string | null;
  report: boolean;
}

/**
 * Datenbank-Attrappe mit Transaktionen und dem CHECK `end_date >= start_date`: Änderungen in BEGIN … COMMIT werden
 * erst beim COMMIT sichtbar, ROLLBACK verwirft sie. Ohne Transaktion wirkt jedes Statement sofort.
 */
function sprintDb(initial: SprintRow, options: { failReport?: boolean } = {}) {
  let committed = { ...initial };
  let open: SprintRow | null = null;
  const query = async (sql: string) => {
    const text = sql.trim();
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
      if (text === 'COMMIT' && open) committed = open;
      open = text === 'BEGIN' ? { ...committed } : null;
      return { rows: [] };
    }
    const row = open ?? committed;
    const view = () => ({ id: SPRINT_ID, status: row.status, startDate: row.startDate, endDate: row.endDate });
    if (text.startsWith('SELECT status')) {
      return { rows: [{ status: row.status, slug: 'demo', running: 0, waiting: 0 }] };
    }
    if (text.includes("UPDATE sprints SET status = 'completed'")) {
      const fallback =
        text.includes('GREATEST(start_date, CURRENT_DATE)') && row.startDate && row.startDate > TODAY
          ? row.startDate
          : TODAY;
      const end = row.endDate ?? fallback;
      if (row.startDate && end < row.startDate)
        throw Object.assign(new Error('new row violates check constraint'), { code: '23514' });
      row.status = 'completed';
      row.endDate = end;
      return { rows: [] };
    }
    if (text.includes("git_sync = 'pending'")) {
      row.gitSync = 'pending';
      return { rows: [] };
    }
    if (text.startsWith('UPDATE sprints SET status = $2')) {
      row.status = 'completed';
      return { rows: [view()] };
    }
    if (text.includes('AS "projectSlug", name, goal, COALESCE(start_date'))
      return { rows: [{ projectSlug: 'demo', name: 'Sprint 21', goal: '', startedAt: new Date(TODAY) }] };
    if (text.includes('INSERT INTO sprint_reports')) {
      if (options.failReport) throw new Error('Bericht konnte nicht gespeichert werden');
      row.report = true;
      return { rows: [] };
    }
    if (text.includes('to_char(start_date')) return { rows: [view()] };
    if (text.includes('COUNT(*) FILTER')) return { rows: [{ failed: '0', total: '0' }] };
    return { rows: [] };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return { pool, state: () => committed };
}

const futureSprint = (): SprintRow => ({
  status: 'active',
  startDate: FUTURE_START,
  endDate: null,
  gitSync: null,
  report: false,
});

test('Sprint-PATCH: aktiver Sprint mit Startdatum in der Zukunft schliesst mit 200 und Bericht ab', async () => {
  const { pool, state } = sprintDb(futureSprint());
  const { status, json } = await sendPatch(pool, { status: 'completed' });
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(state().status, 'completed');
  assert.equal(state().report, true, 'Sprintbericht entsteht');
  assert.equal(state().endDate, FUTURE_START, 'Ende nie vor dem Start');
  assert.equal(state().gitSync, 'pending', 'Worker übernimmt Merge und Push');
  assert.equal((json as { sprint: { endDate: string } }).sprint.endDate, FUTURE_START, 'Antwort zeigt das Enddatum');
});

test('Sprint-PATCH: scheitert der Abschluss, bleibt der Sprint aktiv – ohne Bericht und ohne Git-Sync', async () => {
  const { pool, state } = sprintDb(futureSprint(), { failReport: true });
  const { status } = await sendPatch(pool, { status: 'completed' });
  assert.notEqual(status, 200);
  assert.equal(state().status, 'active', 'kein Teilzustand „abgeschlossen ohne Bericht“');
  assert.equal(state().endDate, null);
  assert.equal(state().gitSync, null, 'der Worker mergt und pusht nichts');
  // Ein zweiter Versuch ist danach möglich (kein 409 wegen schon abgeschlossenem Sprint).
  const retry = sprintDb(state());
  assert.equal((await sendPatch(retry.pool, { status: 'completed' })).status, 200);
});

interface OpenSprint {
  status: string;
  orders: string[];
  report: boolean;
  gitSync: string | null;
  deleted: boolean;
}

/**
 * Datenbank-Attrappe für Abschluss und Löschen: wertet die Auftragsstatus aus, die das SQL als blockierend zählt
 * (`AND status = '…'` bzw. `AND status IN (…)`), damit der Test die tatsächlich geschriebenen Bedingungen prüft.
 */
function openSprintDb(initial: Omit<OpenSprint, 'report' | 'gitSync' | 'deleted'>) {
  const sprint: OpenSprint = { ...initial, orders: [...initial.orders], report: false, gitSync: null, deleted: false };
  const count = (single: string | undefined, list: string | undefined) => {
    const statuses = single ? [single] : statusList(list);
    return sprint.orders.filter((status) => statuses.includes(status)).length;
  };
  const deletable = (sql: string) => {
    const blocking =
      /NOT EXISTS \(SELECT 1 FROM development_items WHERE sprint_id = s\.id AND status (?:= '(\w+)'|IN \(([^)]*)\))/.exec(
        sql,
      );
    return (
      !sprint.deleted &&
      statusList(/status IN \(([^)]*)\)/.exec(sql)?.[1]).includes(sprint.status) &&
      count(blocking?.[1], blocking?.[2]) === 0
    );
  };
  const query = async (sql: string) => {
    const text = sql.trim();
    const view = () => ({ id: SPRINT_ID, status: sprint.status });
    if (text.startsWith('SELECT status')) {
      const row: Record<string, unknown> = { status: sprint.status, slug: 'demo' };
      for (const match of text.matchAll(/AND status (?:= '(\w+)'|IN \(([^)]*)\))\) AS (\w+)/g)) {
        row[match[3]!] = count(match[1], match[2]);
      }
      return { rows: [row] };
    }
    if (text.startsWith("UPDATE development_items SET status = 'backlog'")) {
      if (deletable(text)) sprint.orders = sprint.orders.map((status) => (status === 'planned' ? 'backlog' : status));
      return { rows: [] };
    }
    if (text.startsWith('DELETE FROM sprints')) {
      if (!deletable(text)) return { rows: [] };
      sprint.deleted = true;
      return { rows: [{ id: SPRINT_ID }] };
    }
    if (text.startsWith('SELECT 1 FROM sprints')) return { rows: sprint.deleted ? [] : [{ '?column?': 1 }] };
    if (text.includes("UPDATE sprints SET status = 'completed'") || text.startsWith('UPDATE sprints SET status = $2')) {
      sprint.status = 'completed';
      return { rows: [view()] };
    }
    if (text.includes("git_sync = 'pending'")) {
      sprint.gitSync = 'pending';
      return { rows: [] };
    }
    if (text.includes('AS "projectSlug", name, goal, COALESCE(start_date'))
      return { rows: [{ projectSlug: 'demo', name: 'Sprint 23', goal: '', startedAt: new Date(TODAY) }] };
    if (text.includes('INSERT INTO sprint_reports')) {
      sprint.report = true;
      return { rows: [] };
    }
    if (text.includes('to_char(start_date')) return { rows: [view()] };
    if (text.includes('COUNT(*) FILTER')) return { rows: [{ failed: '0', total: '0' }] };
    return { rows: [] };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return { pool, sprint };
}

async function deleteSprint(pool: Pool) {
  const app = express();
  const api = express.Router();
  registerSprintRoutes(api, pool);
  app.use('/api', api);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sprints/${SPRINT_ID}`;
    const response = await fetch(url, { method: 'DELETE' });
    return { status: response.status, json: (await response.json().catch(() => null)) as { message?: string } | null };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('Sprint mit Auftrag in Freigabe: Abschluss und Löschen liefern 409 und ändern nichts', async () => {
  // Abschluss (= Live schalten): ohne den Riegel mergte „Freigeben“ später in einen abgeschlossenen Sprint.
  const active = openSprintDb({ status: 'active', orders: ['done', 'approval'] });
  assert.equal((await sendPatch(active.pool, { status: 'completed' })).status, 409);
  assert.deepEqual(
    { status: active.sprint.status, report: active.sprint.report, gitSync: active.sprint.gitSync },
    { status: 'active', report: false, gitSync: null },
    'kein Abschluss, kein Bericht, kein Git-Sync (Tag)',
  );
  // Löschen: ein geplanter Sprint mit einzeln gestartetem Auftrag, der auf Freigabe wartet.
  for (const waiting of ['approval', 'in_progress']) {
    const planned = openSprintDb({ status: 'planned', orders: ['planned', waiting] });
    const { status, json } = await deleteSprint(planned.pool);
    assert.equal(status, 409, `DELETE mit Auftrag in ${waiting}`);
    assert.match(json?.message ?? '', /laufen oder auf Freigabe warten/);
    assert.equal(planned.sprint.deleted, false, 'Sprint bleibt erhalten');
    assert.deepEqual(planned.sprint.orders, ['planned', waiting], 'geplante Aufträge bleiben geplant');
  }
});

test('Sprint ohne laufenden oder wartenden Auftrag: Abschluss und Löschen klappen weiter', async () => {
  const active = openSprintDb({ status: 'active', orders: ['done', 'rejected'] });
  assert.equal((await sendPatch(active.pool, { status: 'completed' })).status, 200);
  assert.equal(active.sprint.report, true);
  assert.equal(active.sprint.gitSync, 'pending');
  const planned = openSprintDb({ status: 'planned', orders: ['planned', 'done'] });
  assert.equal((await deleteSprint(planned.pool)).status, 204);
  assert.equal(planned.sprint.deleted, true);
  assert.deepEqual(planned.sprint.orders, ['backlog', 'done'], 'geplante Aufträge gehen ins Backlog');
});

test('completeSprint (Worker/Autopilot): Startdatum in der Zukunft, Abschluss atomar mit Bericht', async () => {
  const ok = sprintDb(futureSprint());
  await completeSprint(ok.pool, SPRINT_ID);
  assert.deepEqual(ok.state(), {
    status: 'completed',
    startDate: FUTURE_START,
    endDate: FUTURE_START,
    gitSync: 'pending',
    report: true,
  });
  const failing = sprintDb(futureSprint(), { failReport: true });
  await assert.rejects(completeSprint(failing.pool, SPRINT_ID));
  assert.equal(failing.state().status, 'active');
  assert.equal(failing.state().gitSync, null);
});
