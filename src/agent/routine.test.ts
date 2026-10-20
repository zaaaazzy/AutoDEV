import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import {
  createdSummary,
  finishTaskRun,
  isEnvironmentFailure,
  MAX_FAILURE_STREAK,
  type RoutineRun,
  routineInstructions,
  scheduleRoutines,
  storeMarkers,
  stripMarkers,
} from './routine.js';

type Query = { sql: string; values: unknown[] };
type Handler = (sql: string, values: unknown[]) => { rows: unknown[]; rowCount?: number } | undefined;

/** Kleiner Fake: erkennt die Abfragen am SQL-Text, protokolliert alles; Transaktionen laufen über connect(). */
function fakePool(handler: Handler = () => undefined) {
  const queries: Query[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values });
    return handler(sql, values) ?? { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return { pool, queries };
}

const pushes = () => {
  const sent: { title: string; body: string }[] = [];
  const push = async (_pool: Pool, message: { title: string; body: string }) => {
    sent.push(message);
    return 1;
  };
  return { sent, push };
};

const run = (overrides: Partial<RoutineRun> = {}): RoutineRun => ({
  id: 'run-1',
  taskId: 'task-1',
  trigger: 'schedule',
  status: 'running',
  title: 'Sicherheits-Check',
  outputTarget: 'bug',
  ...overrides,
});

const taskState =
  (streak: number, enabled = true, status = 'running') =>
  (sql: string) =>
    sql.includes('t.failure_streak AS streak') ? { rows: [{ streak, enabled, status }] } : undefined;

test('Umgebungsfehler (fehlende CLI, Ordner weg, Budget) zählen nicht als Fehlschlag', () => {
  assert.equal(isEnvironmentFailure('Error: spawn claude ENOENT'), true);
  assert.equal(isEnvironmentFailure('Befehl „claude“ wurde im PATH des Workers nicht gefunden'), true);
  assert.equal(isEnvironmentFailure('Budget erreicht: erhöhen oder bis morgen warten (Tag)'), true);
  assert.equal(isEnvironmentFailure('3 Tests schlagen fehl'), false);
});

test('Routine-Prompt: keine Rückfragen, nur lesen, Marker und Ziel', () => {
  const text = routineInstructions('order');
  assert.match(text, /keine @@FRAGE/);
  assert.match(text, /Nur lesen/);
  assert.match(text, /@@BUG \{/);
  assert.match(text, /@@ORDER \{/);
  assert.match(text, /Auftrag im Backlog/);
});

test('Marker: je ein Bug, eine Idee und ein Auftrag mit Quelle Routine; kaputtes JSON nur im Protokoll', async () => {
  let next = 0;
  const { pool, queries } = fakePool((sql) =>
    sql.includes('INSERT INTO') ? { rows: [{ id: `id-${++next}` }] } : undefined,
  );
  const output = [
    'Bericht: zwei Befunde.',
    '@@BUG {"title": "lodash mit Prototype Pollution", "severity": "hoch", "description": "npm audit: lodash < 4.17.21"}',
    '@@IDEA {"title": "Abhängigkeiten monatlich aktualisieren", "priority": "niedrig"}',
    '@@ORDER {"title": "README: Startbefehl korrigieren", "priority": "high"}',
    '@@BUG {kaputt',
  ].join('\n');
  const result = await storeMarkers(pool, 'mainty', { id: 'run-1', title: 'Check', messageId: 'msg-1' }, output);
  assert.deepEqual(
    result.created.map((item) => item.kind),
    ['bug', 'idea', 'order'],
  );
  const inserts = queries.filter((query) => query.sql.includes('INSERT INTO'));
  assert.equal(inserts.length, 3, 'kaputtes JSON legt nichts an');
  const bug = inserts.find((query) => query.sql.includes('INSERT INTO bugs'))!;
  assert.match(bug.sql, /'routine'/);
  assert.equal(bug.values[3], 'high');
  assert.equal(bug.values.at(-1), 'run-1');
  assert.match(String(bug.values[2]), /Routine „Check“.*Chat-Nachricht msg-1/s);
  const order = inserts.find((query) => query.sql.includes('INSERT INTO development_items'))!;
  assert.match(order.sql, /'backlog'/);
  assert.equal(order.values.at(-1), 'run-1');
  assert.equal(inserts.find((query) => query.sql.includes('INSERT INTO ideation_items'))!.values.at(-1), 'run-1');
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0]!, /Kein gültiges JSON/);
});

test('Marker: offener Eintrag mit gleichem Titel wird nicht doppelt angelegt', async () => {
  const { pool } = fakePool(() => ({ rows: [] }));
  const result = await storeMarkers(
    pool,
    'mainty',
    { id: 'run-1', title: 'Check', messageId: null },
    '@@BUG {"title": "Gleich"}',
  );
  assert.equal(result.created.length, 0);
  assert.match(result.notes[0]!, /bereits offen/);
});

test('Chat-Text ohne Marker-Zeilen, dafür die Liste der angelegten Einträge', () => {
  assert.equal(stripMarkers('Bericht\n@@BUG {"title": "x"}\n  @@ORDER {}\nEnde'), 'Bericht\nEnde');
  assert.match(
    createdSummary([{ kind: 'bug', id: '1', title: 'Lücke' }], ['Kein gültiges JSON.']),
    /Bug angelegt: „Lücke“/,
  );
  assert.equal(createdSummary([], []), '');
});

test('Fehlschlag: genau eine Push-Meldung, Zählung steigt', async () => {
  const { pool, queries } = fakePool(taskState(0));
  const { sent, push } = pushes();
  const result = await finishTaskRun(
    pool,
    { run: run(), project: 'mainty', messageId: 'm', failed: true, output: 'Tests rot', tokens: 120, durationMs: 900 },
    push,
  );
  assert.equal(result.paused, false);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.title, /fehlgeschlagen/);
  const log = queries.find((query) => query.sql.includes("UPDATE agent_task_runs SET status = 'failed'"))!;
  assert.deepEqual(log.values.slice(1, 5), [900, 120, 'Tests rot', false]);
  const task = queries.find((query) => query.sql.includes("UPDATE agent_tasks SET last_status = 'failed'"))!;
  assert.deepEqual(task.values.slice(2), [1, false]);
});

test(`Nach dem ${MAX_FAILURE_STREAK}. Fehlschlag in Folge pausiert, Grund in last_error, eine Push-Meldung`, async () => {
  const { pool, queries } = fakePool(taskState(MAX_FAILURE_STREAK - 1));
  const { sent, push } = pushes();
  const result = await finishTaskRun(
    pool,
    { run: run(), project: 'mainty', messageId: 'm', failed: true, output: 'Tests rot', tokens: 0, durationMs: 1 },
    push,
  );
  assert.equal(result.paused, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.title, /pausiert/);
  const task = queries.find((query) => query.sql.includes("UPDATE agent_tasks SET last_status = 'failed'"))!;
  assert.match(String(task.values[1]), /Pausiert nach 3 Fehlschlägen in Folge/);
  assert.deepEqual(task.values.slice(2), [MAX_FAILURE_STREAK, true]);
});

test('Umgebungsfehler: gemeldet, aber nicht gezählt und nie pausiert', async () => {
  const { pool, queries } = fakePool(taskState(MAX_FAILURE_STREAK - 1));
  const { sent, push } = pushes();
  const result = await finishTaskRun(
    pool,
    {
      run: run(),
      project: 'mainty',
      messageId: 'm',
      failed: true,
      output: 'spawn claude ENOENT',
      tokens: 0,
      durationMs: 1,
    },
    push,
  );
  assert.equal(result.paused, false);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.title, /Umgebungsfehler/);
  const task = queries.find((query) => query.sql.includes("UPDATE agent_tasks SET last_status = 'failed'"))!;
  assert.deepEqual(task.values.slice(2), [MAX_FAILURE_STREAK - 1, false]);
});

test('Vom Benutzer abgebrochener Lauf: keine Meldung, keine Zählung', async () => {
  const { pool, queries } = fakePool(taskState(1, false, 'cancelled'));
  const { sent, push } = pushes();
  await finishTaskRun(
    pool,
    { run: run(), project: 'mainty', messageId: 'm', failed: true, output: 'x', tokens: 0, durationMs: 1 },
    push,
  );
  assert.equal(sent.length, 0);
  assert.ok(!queries.some((query) => query.sql.includes('UPDATE agent_tasks')));
});

test('Erfolg: Protokoll mit Tokens, Zählung zurück, Push nur beim Ziel „Push“', async () => {
  const quiet = fakePool(taskState(2));
  const first = pushes();
  await finishTaskRun(
    quiet.pool,
    {
      run: run({ outputTarget: 'chat' }),
      project: 'p',
      messageId: 'm',
      failed: false,
      output: 'Alles gut',
      tokens: 42,
      durationMs: 5,
    },
    first.push,
  );
  assert.equal(first.sent.length, 0);
  const log = quiet.queries.find((query) => query.sql.includes("SET status = 'ok'"))!;
  assert.deepEqual(log.values.slice(1, 3), [5, 42]);
  const loud = fakePool(taskState(0));
  const second = pushes();
  await finishTaskRun(
    loud.pool,
    {
      run: run({ outputTarget: 'push' }),
      project: 'p',
      messageId: 'm',
      failed: false,
      output: 'Alles gut',
      tokens: 1,
      durationMs: 1,
    },
    second.push,
  );
  assert.equal(second.sent.length, 1);
  assert.equal(second.sent[0]!.body, 'Alles gut');
});

test('Klick-Lauf: Marker werden nicht ausgewertet, Fehlschläge nicht gezählt', async () => {
  const { pool, queries } = fakePool(taskState(2));
  const { push } = pushes();
  await finishTaskRun(
    pool,
    {
      run: run({ trigger: 'manual' }),
      project: 'p',
      messageId: 'm',
      failed: false,
      output: '@@BUG {"title": "x y z"}',
      tokens: 1,
      durationMs: 1,
    },
    push,
  );
  assert.ok(!queries.some((query) => query.sql.includes('INSERT INTO bugs')));
  const failed = fakePool(taskState(2));
  const result = await finishTaskRun(
    failed.pool,
    {
      run: run({ trigger: 'manual' }),
      project: 'p',
      messageId: 'm',
      failed: true,
      output: 'rot',
      tokens: 1,
      durationMs: 1,
    },
    push,
  );
  assert.equal(result.paused, false);
});

test('Planer: sperrt fällige Routinen mit SKIP LOCKED, wartet bei Projektsperre, reiht freie ein', async () => {
  const due = [
    {
      id: 't-locked',
      projectSlug: 'a',
      title: 'A',
      prompt: 'p',
      agentId: null,
      schedule: '0 2 * * *',
      runWindow: null,
      locked: true,
      open: false,
    },
    {
      id: 't-free',
      projectSlug: 'b',
      title: 'B',
      prompt: 'p',
      agentId: null,
      schedule: '0 2 * * *',
      runWindow: null,
      locked: false,
      open: false,
    },
    {
      id: 't-open',
      projectSlug: 'b',
      title: 'C',
      prompt: 'p',
      agentId: null,
      schedule: '0 2 * * *',
      runWindow: null,
      locked: false,
      open: true,
    },
  ];
  const { pool, queries } = fakePool((sql) => {
    if (sql.includes('FOR UPDATE OF t SKIP LOCKED')) return { rows: due };
    if (sql.includes('INSERT INTO agent_task_runs')) return { rows: [{ id: 'run-9' }] };
    if (sql.includes('INSERT INTO chat_messages')) return { rows: [{ id: 'msg-9' }] };
    return undefined;
  });
  const now = new Date('2026-10-21T00:00:30Z'); // 02:00 Zürich
  const result = await scheduleRoutines(pool, ['a', 'b'], now);
  assert.deepEqual(result, { queued: ['t-free'], waiting: ['t-locked'], skipped: ['t-open'] });
  const select = queries.find((query) => query.sql.includes('SKIP LOCKED'))!;
  assert.match(select.sql, /agent_runs r WHERE r\.project_slug = t\.project_slug AND r\.status = 'running'/);
  const message = queries.find((query) => query.sql.includes('INSERT INTO chat_messages'))!;
  assert.equal(message.values[3], 'routine');
  assert.equal(message.values[4], 'run-9');
  // Nächster Termin für die eingereihte Routine: morgen 02:00 Zürich.
  const next = queries.filter((query) => query.sql.includes('SET next_run_at') && query.values[0] === 't-free');
  assert.equal((next[0]!.values[1] as Date).toISOString(), '2026-10-22T00:00:00.000Z');
  assert.ok(!queries.some((query) => query.sql.includes('SET next_run_at') && query.values[0] === 't-locked'));
  assert.ok(queries.some((query) => query.sql === 'COMMIT'));
});

test('Planer: außerhalb des Zeitfensters wird der Termin ausgelassen', async () => {
  const due = [
    {
      id: 't',
      projectSlug: 'a',
      title: 'A',
      prompt: 'p',
      agentId: null,
      schedule: '0 * * * *',
      runWindow: '22:00-06:00',
      locked: false,
      open: false,
    },
  ];
  const { pool, queries } = fakePool((sql) => (sql.includes('SKIP LOCKED') ? { rows: due } : undefined));
  // 12:00 Zürich: Fenster vorbei (z. B. nach langer Projektsperre).
  const result = await scheduleRoutines(pool, ['a'], new Date('2026-11-02T11:00:00Z'));
  assert.deepEqual(result.skipped, ['t']);
  assert.ok(!queries.some((query) => query.sql.includes('INSERT INTO chat_messages')));
  const next = queries.find((query) => query.sql.includes('SET next_run_at') && query.values[0] === 't')!;
  assert.equal((next.values[1] as Date).toISOString(), '2026-11-02T21:00:00.000Z');
});
