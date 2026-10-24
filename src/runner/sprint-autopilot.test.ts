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

test('Sprint nicht fertig, wenn Aufträge nur am Arbeitsordner oder Laufwerk scheiterten (Sprint 20)', () => {
  const git = { status: 'blocked', actionTodo: 'Arbeitsordner aufräumen (Git)' };
  const drive = {
    status: 'blocked',
    actionTodo: 'Projektordner bzw. Laufwerk nicht erreichbar – anschliessen, der Auftrag startet dann neu',
  };
  const done = { status: 'done', actionTodo: null };
  assert.equal(sprintSettled([done, done, git]), false);
  assert.equal(sprintSettled([done, drive]), false);
  // Eine echte „Aktion notwendig“ (z. B. Zugangsdaten eintragen) wartet weiterhin auf einen Menschen.
  assert.equal(sprintSettled([done, { status: 'blocked', actionTodo: 'API-Schlüssel eintragen' }]), true);
});

test('Budget je Auftrag gibt nie von selbst frei: dieser Auftrag hält den Sprint nicht ewig offen', () => {
  const done = { status: 'done', actionTodo: null };
  const order = { status: 'blocked', actionTodo: 'Budget je Auftrag erreicht', budgetBlocked: 'order' };
  const day = { status: 'blocked', actionTodo: 'Tagesbudget erreicht', budgetBlocked: 'day' };
  assert.equal(sprintSettled([done, order]), true);
  assert.equal(sprintSettled([done, day]), false);
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

/** Aktiver Sprint mit erledigten Aufträgen; `autoLive` ist die Projekteinstellung „Autopilot schaltet selbst live“. */
function finishedSprintPool(autoLive: boolean, items = [{ status: 'done', actionTodo: null }], completable = true) {
  const statements: string[] = [];
  const answer = (sql: string) => {
    statements.push(sql);
    if (sql.includes('autopilot_start AS start'))
      return [{ mode: 'autopilot', start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5], released: null, autoLive }];
    if (sql.includes("WHERE project_slug = $1 AND status = 'active'")) return [{ id: 'sprint-9', name: 'Sprint 9' }];
    if (sql.includes('FROM development_items') && sql.includes('sprint_id = $1')) return items;
    if (sql.includes("UPDATE sprints s SET status = 'completed'")) return completable ? [{ id: 'sprint-9' }] : [];
    return [];
  };
  const query = async (sql: string) => ({ rows: answer(sql) });
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return {
    pool,
    completed: () => statements.some((sql) => sql.includes("UPDATE sprints s SET status = 'completed'")),
    queuedSync: () => statements.some((sql) => sql.includes("SET git_sync = 'pending'")),
  };
}

test('Autopilot schaltet selbst live: fertiger Sprint wird abgeschlossen und die Git-Sicherung eingereiht', async () => {
  const { pool, completed, queuedSync } = finishedSprintPool(true);
  assert.equal(await sprintAutopilot(pool, 'demo', MONDAY_10), 'completed');
  assert.ok(completed(), 'Sprint auf abgeschlossen gesetzt');
  assert.ok(queuedSync(), 'Test-Gate, Merge und Push eingereiht');
});

test('Ohne „selbst live“ wartet ein fertiger Sprint weiter auf das Go', async () => {
  const { pool, completed } = finishedSprintPool(false);
  assert.equal(await sprintAutopilot(pool, 'demo', MONDAY_10), 'review');
  assert.equal(completed(), false);
});

test('„Selbst live“ nur in den Arbeitszeiten, nie mit offener Arbeit, nie bei pausiertem Sprint', async () => {
  const night = finishedSprintPool(true);
  assert.equal(await sprintAutopilot(night.pool, 'demo', MONDAY_22), 'review');
  assert.equal(night.completed(), false);

  const open = finishedSprintPool(true, [
    { status: 'done', actionTodo: null },
    { status: 'approval', actionTodo: null },
  ]);
  assert.equal(await sprintAutopilot(open.pool, 'demo', MONDAY_10), 'working');
  assert.equal(open.completed(), false);

  // Pausiert oder ein Auftrag läuft doch noch: das UPDATE trifft keine Zeile, der Sprint wartet.
  const paused = finishedSprintPool(true, undefined, false);
  assert.equal(await sprintAutopilot(paused.pool, 'demo', MONDAY_10), 'review');
  assert.equal(paused.queuedSync(), false);
});
