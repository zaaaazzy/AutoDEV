import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import type { Pool } from 'pg';
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
  } as unknown as Pool;
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
    return { status: response.status, queries };
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
