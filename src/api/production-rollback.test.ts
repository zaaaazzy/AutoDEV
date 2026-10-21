import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Pool } from 'pg';
import { createDevLogApp } from './app.js';

const BUG = '33333333-3333-4333-8333-333333333333';
const FROM = 'sprint-sprint-2-bbbbbb';
const TO = 'sprint-sprint-1-aaaaaa';

interface State {
  severity: string;
  suspect: boolean;
  running: boolean;
  /** Bereits offener Rollback (eindeutiger Index greift). */
  open: boolean;
}

/** Pool-Attrappe: ein Betriebs-Bug, zwei abgeschlossene Sprints, letzter Deploy auf FROM. Zählt Rollback-Anforderungen. */
function rollbackPool(overrides: Partial<State> = {}) {
  const state: State = { severity: 'critical', suspect: true, running: false, open: false, ...overrides };
  const inserts: unknown[][] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('FROM bugs b JOIN projects p')) {
        return {
          rows: [
            {
              project: 'shop',
              source: 'production',
              severity: state.severity,
              suspect: state.suspect,
              commands: true,
              separate: true,
            },
          ],
        };
      }
      if (sql.includes('FROM production_deploys WHERE project_slug = $1 ORDER BY deployed_at DESC')) {
        return { rows: [{ deployedAt: new Date('2026-10-22T10:00:00Z'), sprintTag: FROM, newMigrations: [] }] };
      }
      if (sql.includes("FROM sprints WHERE project_slug = $1 AND status = 'completed'")) {
        return {
          rows: [
            { id: 'aaaaaa00', name: 'Sprint 1' },
            { id: 'bbbbbb00', name: 'Sprint 2' },
          ],
        };
      }
      if (sql.includes('AS running')) return { rows: [{ running: state.running }] };
      if (sql.includes('INSERT INTO production_rollbacks')) {
        if (state.open) return { rows: [], rowCount: 0 };
        inserts.push(values);
        state.open = true;
        return { rows: [{ id: 'r-1', fromTag: values[2], toTag: values[3], status: 'requested' }], rowCount: 1 };
      }
      if (sql.includes('FROM production_rollbacks WHERE bug_id')) return { rows: [] };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, inserts, state };
}

async function call(pool: Pool, method: 'GET' | 'POST', body?: unknown) {
  const server = createDevLogApp(pool, null).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/bugs/${BUG}/rollback`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('GET /bugs/:id/rollback: kritischer Betriebsbug mit Deploy-Verdacht bekommt den Vorschlag mit beiden Tags', async () => {
  const result = await call(rollbackPool().pool, 'GET');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.proposal, {
    fromTag: FROM,
    toTag: TO,
    deployedAt: '2026-10-22T10:00:00.000Z',
    disabledReason: null,
    migrations: [],
  });
  // Ohne Ereignis im 30-Minuten-Fenster: kein Vorschlag, also kein Knopf.
  assert.equal((await call(rollbackPool({ suspect: false }).pool, 'GET')).body.proposal, null);
});

test('POST /bugs/:id/rollback: ohne Bestätigung des Zieltags wird nichts ausgelöst', async () => {
  const { pool, inserts } = rollbackPool();
  assert.equal((await call(pool, 'POST', {})).status, 400);
  assert.equal((await call(pool, 'POST', { toTag: FROM })).status, 409);
  assert.equal(inserts.length, 0);
});

test('POST /bugs/:id/rollback: nach Bestätigung genau eine Anforderung auf den genannten Zieltag', async () => {
  const { pool, inserts } = rollbackPool();
  const first = await call(pool, 'POST', { toTag: TO });
  assert.equal(first.status, 201);
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0]?.slice(0, 4), ['shop', BUG, FROM, TO]);
  // Zweiter Klick: es läuft schon ein Rollback (Deploy) – keine zweite Anforderung.
  const second = await call(pool, 'POST', { toTag: TO });
  assert.equal(second.status, 409);
  assert.equal(inserts.length, 1);
});

test('POST /bugs/:id/rollback: bei laufendem Deploy oder ohne Vorschlag abgelehnt', async () => {
  const running = rollbackPool({ running: true });
  const blocked = await call(running.pool, 'POST', { toTag: TO });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.message, 'Es läuft bereits ein Deploy des Projekts.');
  const notCritical = rollbackPool({ severity: 'high' });
  assert.equal((await call(notCritical.pool, 'POST', { toTag: TO })).status, 409);
  assert.equal(running.inserts.length + notCritical.inserts.length, 0);
});
