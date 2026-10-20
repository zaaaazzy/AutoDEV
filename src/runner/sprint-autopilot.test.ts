import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { sprintAutopilot, sprintSettled } from './sprint-autopilot.js';

// Montag, 19.10.2026 (Ortszeit): 10:00 liegt in den Arbeitszeiten Mo–Fr 08:00–18:00, 22:00 nicht.
const MONDAY_10 = new Date(2026, 9, 19, 10, 0);
const MONDAY_22 = new Date(2026, 9, 19, 22, 0);
const ORDER_ID = '11111111-1111-4111-8111-111111111111';

/** Simulierte Datenbank: Projekt im Modus Autopilot, kein aktiver Sprint, ein offener Auftrag im Backlog. */
function fakePool(lastSprint: { id: string; name: string; sync: string | null; message: string | null } | null) {
  const statements: string[] = [];
  const answer = (sql: string) => {
    statements.push(sql);
    if (sql.includes('autopilot_start AS start'))
      return [{ mode: 'autopilot', start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5], released: null }];
    if (sql.includes('git_sync AS sync')) return lastSprint ? [lastSprint] : [];
    if (sql.includes('sprint_mode AS mode, sprint_capacity_hours'))
      return [{ mode: 'autopilot', capacity: 40, sprints: '1' }];
    if (sql.includes('FROM development_items d LEFT JOIN sprints'))
      return [
        {
          id: ORDER_ID,
          title: 'Login verbessern',
          description: '',
          status: 'backlog',
          priority: 'high',
          kind: 'feature',
          benefit: null,
          cost: null,
          effortHours: 4,
          tokenEstimate: null,
          followUpOf: null,
          troubled: false,
          actionTodo: null,
        },
      ];
    if (sql.includes('INSERT INTO sprints')) return [{ id: 'new-sprint' }];
    return [];
  };
  const client = { query: async (sql: string) => ({ rows: answer(sql) }), release: () => undefined };
  const pool = {
    query: async (sql: string) => ({ rows: answer(sql) }),
    connect: async () => client,
  } as unknown as Pool;
  return { pool, started: () => statements.some((sql) => sql.includes('INSERT INTO sprints')) };
}

test('Autopilot startet innerhalb der Arbeitszeiten den nächsten Sprint', async () => {
  const { pool, started } = fakePool(null);
  assert.equal(await sprintAutopilot(pool, 'demo', MONDAY_10), 'started');
  assert.ok(started());
});

test('Autopilot startet ausserhalb der Arbeitszeiten keinen neuen Sprint', async () => {
  const { pool, started } = fakePool(null);
  assert.equal(await sprintAutopilot(pool, 'demo', MONDAY_22), 'outside_hours');
  assert.equal(started(), false);
});

test('Autopilot pausiert nach gescheitertem Merge und startet keinen Sprint', async () => {
  const { pool, started } = fakePool({ id: 'old', name: 'Sprint 1', sync: 'failed', message: 'Merge-Konflikt' });
  assert.equal(await sprintAutopilot(pool, 'demo', MONDAY_10), 'paused');
  assert.equal(started(), false);
});

test('Sprint nicht fertig, solange ein Auftrag wegen Budget wartet (er läuft von selbst weiter)', () => {
  const budget = { status: 'blocked', actionTodo: 'Budget erreicht: Tageslimit …', budgetBlocked: 'day' };
  assert.equal(sprintSettled([{ status: 'done', actionTodo: null }, budget]), false);
  assert.equal(
    sprintSettled([
      { status: 'done', actionTodo: null },
      { ...budget, budgetBlocked: null },
    ]),
    true,
  );
});
