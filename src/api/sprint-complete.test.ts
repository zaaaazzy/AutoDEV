import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import type { Pool } from 'pg';
import { completeSprint } from './sprint-planning.js';
import { registerSprintRoutes } from './sprints.js';

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
      sql.includes("status = CASE WHEN status = 'planned' THEN 'backlog' ELSE status END") &&
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
