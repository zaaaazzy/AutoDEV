import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import type { Pool } from 'pg';
import { startProgress } from './chat-progress.js';

/** Fake-Pool ohne Datenbank: merkt sich jede Abfrage; `fail` lässt passende Abfragen scheitern. */
function fakePool(options: { id?: string | null; fail?: RegExp } = {}) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (options.fail?.test(sql)) throw new Error('Datenbank weg');
      if (sql.includes('INSERT INTO chat_messages')) {
        return { rows: options.id === null ? [] : [{ id: options.id ?? 'msg-1' }] };
      }
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, queries };
}

/** Wartet, bis alle angestossenen (nicht abgewarteten) Abfragen durch sind. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => mock.timers.enable({ apis: ['setInterval', 'Date'] }));
afterEach(() => mock.timers.reset());

test('Chat: Zwischenmeldung mit Laufzeit, Stufen nach Zeit, Ereignisse und Aufräumen', async () => {
  const { pool, queries } = fakePool();
  const progress = await startProgress(pool, 'p', ['Liest', 'Schreibt'], { stepId: 'step-1' });
  const insert = queries.find((query) => query.sql.includes('INSERT INTO chat_messages'));
  assert.deepEqual(insert?.values, ['p', 'Liest (0 s)']);
  assert.deepEqual(queries[0]?.values, ['step-1', 'Liest (0 s)'], 'der Schritt bekommt dieselbe Meldung');

  queries.length = 0;
  // Schrittweise, damit die gemockte Uhr bei jedem Intervall die passende Laufzeit zeigt.
  mock.timers.tick(8_000);
  mock.timers.tick(8_000);
  await settle();
  const ticks = queries.filter((query) => query.sql.includes('UPDATE chat_messages SET content = $2 WHERE'));
  assert.deepEqual(
    ticks.map((query) => query.values[1]),
    ['Liest (8 s)', 'Schreibt (16 s)'],
  );
  assert.equal(queries.filter((query) => query.sql.includes('agent_run_steps')).length, 2);

  mock.timers.tick(30_000);
  await settle();
  assert.match(String(queries.at(-2)?.values[1]), /^Schreibt \(\d+ s\)$/, 'nach der letzten Stufe bleibt sie stehen');

  queries.length = 0;
  progress.update('Führt Tests aus');
  await settle();
  assert.equal(progress.events().length, 1);
  assert.equal(progress.events()[0]?.text, 'Führt Tests aus');
  const update = queries.find((query) => query.sql.includes('events = events ||'));
  assert.equal(update?.values[1], 'Führt Tests aus (46 s)');
  assert.deepEqual(JSON.parse(String(update?.values[2])), progress.events());

  queries.length = 0;
  await progress.stop();
  assert.deepEqual(
    queries.map((query) => query.values),
    [['step-1', null], ['msg-1']],
  );
  assert.match(queries[1]!.sql, /DELETE FROM chat_messages/);
  queries.length = 0;
  mock.timers.tick(20_000);
  await settle();
  assert.equal(queries.length, 0, 'nach stop() tickt nichts mehr');
});

test('Chat ohne Schritt und ohne Stufen: „Arbeite …“ und keine Schritt-Abfragen', async () => {
  const { pool, queries } = fakePool();
  const progress = await startProgress(pool, 'p', []);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0]?.values, ['p', 'Arbeite … (0 s)']);
  mock.timers.tick(8_000);
  await settle();
  assert.equal(queries.filter((query) => query.sql.includes('agent_run_steps')).length, 0);
  await progress.stop();
});

test('still (silent): nur der Schritt wird aktualisiert, keine Chat-Nachricht', async () => {
  const { pool, queries } = fakePool();
  const progress = await startProgress(pool, 'p', ['Prüft'], { stepId: 'step-2', silent: true });
  mock.timers.tick(8_000);
  progress.update('Fast fertig');
  await settle();
  await progress.stop();
  assert.ok(queries.every((query) => query.sql.includes('agent_run_steps')));
  assert.deepEqual(
    queries.map((query) => query.values[1]),
    ['Prüft (0 s)', 'Prüft (8 s)', 'Fast fertig (8 s)', null],
  );
  assert.deepEqual(progress.events(), [], 'stille Läufe sammeln keine Chat-Ereignisse');

  const quiet = fakePool();
  const none = await startProgress(quiet.pool, 'p', ['x'], { silent: true });
  none.update('y');
  mock.timers.tick(8_000);
  await none.stop();
  assert.equal(quiet.queries.length, 0, 'ohne Schritt und still: gar keine Abfrage');
});

test('Fehler der Datenbank brechen den Lauf nicht ab', async () => {
  // Anlegen scheitert: kein Eintrag, die Rückgabe tut nichts.
  const broken = fakePool({ fail: /INSERT INTO chat_messages/ });
  const noop = await startProgress(broken.pool, 'p', ['x']);
  noop.update('egal');
  await noop.stop();
  assert.deepEqual(noop.events(), []);
  assert.equal(broken.queries.length, 1);

  // Kein Datensatz zurück: ebenso nichts.
  const empty = fakePool({ id: null });
  const nothing = await startProgress(empty.pool, 'p', ['x']);
  nothing.update('egal');
  await nothing.stop();
  assert.equal(empty.queries.length, 1);

  // Aktualisieren und Löschen scheitern: Fehler werden nur protokolliert.
  const flaky = fakePool({ fail: /UPDATE|DELETE/ });
  const progress = await startProgress(flaky.pool, 'p', ['x'], { stepId: 's' });
  mock.timers.tick(8_000);
  progress.update('weiter');
  await settle();
  await assert.doesNotReject(progress.stop());
  assert.equal(progress.events().length, 1);
});
