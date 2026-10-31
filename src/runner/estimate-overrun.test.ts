import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import type { CommandExecutor } from '../core/command.js';
import { BUDGET_CHECK_RETRY_MS, runWorkItem, type WorkflowAgent } from './runner.js';
import { describeOverrun, overrunTodo, rawEstimate } from './estimate-overrun.js';
import { OVERRUN_TODO_PREFIX } from './action-todo.js';

// Überschreitungs-Stopp: Nach jedem Agent-Schritt wird der Verbrauch mit dem Dreifachen der kalibrierten Schätzung
// verglichen. Darüber startet kein weiterer Schritt; der Auftrag wartet als „Aktion notwendig“.

const agent = (name: string, position: number): WorkflowAgent => ({
  id: `${name}-id`,
  name,
  role: 'custom',
  phase: 'while_task',
  position,
  instructions: `${name} macht etwas`,
  command: [name],
});

type Query = { sql: string; values: unknown[] };

/** Erkennt die Ist-Abfrage der Überschreitungsprüfung (loadOrderEffort). */
const isEffortQuery = (sql: string) => sql.includes('COALESCE(SUM(s.duration_ms), 0) AS ms');

/**
 * Fake-Pool: `effort(steps)` liefert den Ist-Wert nach `steps` gelaufenen Agents; `answer` beantwortet weitere Abfragen
 * (z. B. Budget). Alles andere wie im Runner-Test.
 */
function fakePool(
  effort: (steps: number) => { ms: number; tokens: number },
  steps: () => number,
  answer: (sql: string) => { rows: unknown[] } | null = () => null,
) {
  const queries: Query[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('INSERT INTO agent_runs')) return { rows: [{ id: 'run-1' }] };
      if (isEffortQuery(sql)) {
        const { ms, tokens } = effort(steps());
        return { rows: [{ ms: String(ms), tokens: String(tokens) }] };
      }
      // Kalibrierung: keine Messwerte, Faktor 1.
      if (sql.includes('WITH measured AS')) return { rows: [] };
      return answer(sql) ?? { rows: [{ id: 'step-row' }] };
    },
  } as unknown as Pool;
  return { pool, queries };
}

function recorder() {
  const calls: string[] = [];
  const execute: CommandExecutor = async (command) => {
    calls.push(command[0] ?? '');
    return { exitCode: 0, durationMs: 1, output: 'fertig' };
  };
  return { calls, execute };
}

const HOUR_MS = 3_600_000;
const agents = [agent('dev', 1), agent('tester', 2)];
const estimated = (estimate: { effortHours?: number | null; tokenEstimate?: number | null }) => ({
  id: 'item-1',
  projectSlug: 'mainty',
  title: 'Schätzung',
  description: 'Bauen',
  estimateSource: 'author',
  ...estimate,
});

const lastStatus = (queries: Query[]) =>
  queries.filter((query) => query.sql.includes('UPDATE development_items')).at(-1)?.values;

test('Tokens über dem Dreifachen der Schätzung: vor dem nächsten Schritt blockiert, „Aktion notwendig“ mit Ist und Schätzung', async () => {
  const { calls, execute } = recorder();
  const { pool, queries } = fakePool(
    (steps) => ({ ms: 60_000, tokens: steps ? 3_000_001 : 0 }),
    () => calls.length,
  );
  const result = await runWorkItem(pool, estimated({ effortHours: 1, tokenEstimate: 1_000_000 }), agents, {
    cwd: '/r',
    timeoutMs: 1,
    execute,
  });
  assert.equal(result, 'failed');
  assert.deepEqual(calls, ['dev'], 'der Tester startet nicht mehr');
  const failure = queries.find((query) => query.sql === 'UPDATE development_items SET failure = $2 WHERE id = $1');
  assert.match(
    String(failure?.values[1]),
    /^Aktion notwendig: Schätzung überschritten – Ist 0,02 h \/ 3 Mio\. Tokens, kalibrierte Schätzung 1 h \/ 1 Mio\. Tokens/,
  );
  const todo = queries.find((query) => query.sql.includes('SET action_todo = $2'));
  assert.ok(String(todo?.values[1]).startsWith(OVERRUN_TODO_PREFIX), 'erscheint unter „Aktion notwendig“');
  assert.match(String(todo?.values[1]), /Ist 0,02 h \/ 3 Mio\. Tokens, Schätzung 1 h \/ 1 Mio\. Tokens/);
  assert.deepEqual(lastStatus(queries), ['item-1', 'blocked']);
  // Kein Budget-Stopp und kein Bug-Bericht: Es ist kein Code-Fehler.
  assert.ok(!queries.some((query) => query.sql.includes('budget_blocked = $3')));
  assert.ok(!queries.some((query) => query.sql.includes('INSERT INTO bugs')));
});

test('Laufzeit über dem Dreifachen der Stundenschätzung: vor dem nächsten Schritt blockiert', async () => {
  const { calls, execute } = recorder();
  const { pool, queries } = fakePool(
    (steps) => ({ ms: steps ? 1.51 * HOUR_MS : 0, tokens: 10 }),
    () => calls.length,
  );
  await runWorkItem(pool, estimated({ effortHours: 0.5, tokenEstimate: null }), agents, {
    cwd: '/r',
    timeoutMs: 1,
    execute,
  });
  assert.deepEqual(calls, ['dev']);
  assert.deepEqual(lastStatus(queries), ['item-1', 'blocked']);
});

test('genau das Dreifache läuft weiter; nach der Freigabe zählt der Verbrauch ab budget_since neu', async () => {
  const { calls, execute } = recorder();
  const { pool, queries } = fakePool(
    () => ({ ms: 1.5 * HOUR_MS, tokens: 3_000_000 }),
    () => calls.length,
  );
  const result = await runWorkItem(pool, estimated({ effortHours: 0.5, tokenEstimate: 1_000_000 }), agents, {
    cwd: '/r',
    timeoutMs: 1,
    execute,
  });
  assert.equal(result, 'passed');
  assert.deepEqual(calls, ['dev', 'tester']);
  assert.deepEqual(lastStatus(queries), ['item-1', 'done']);
  // Geprüft wird vor jedem Schritt; gezählt werden alle Schritte aller Rollen seit der letzten Freigabe.
  const checks = queries.filter((query) => isEffortQuery(query.sql));
  assert.equal(checks.length, 2);
  assert.match(checks[0]!.sql, /r\.started_at >= d\.budget_since/);
  assert.doesNotMatch(checks[0]!.sql, /role/);
});

test('Auftrag ohne Schätzung wird durch die Prüfung nie blockiert (keine Abfrage)', async () => {
  const { calls, execute } = recorder();
  const { pool, queries } = fakePool(
    () => ({ ms: 100 * HOUR_MS, tokens: 1e9 }),
    () => calls.length,
  );
  const result = await runWorkItem(pool, estimated({ effortHours: null, tokenEstimate: null }), agents, {
    cwd: '/r',
    timeoutMs: 1,
    execute,
  });
  assert.equal(result, 'passed');
  assert.deepEqual(calls, ['dev', 'tester']);
  assert.ok(!queries.some((query) => isEffortQuery(query.sql)));
});

test('Prüfung scheitert (Datenbank weg): kein Agent startet ungeprüft, Auftrag unterbrochen mit Pause', async () => {
  const { calls, execute } = recorder();
  const { pool, queries } = fakePool(
    () => {
      throw Object.assign(new Error('Connection terminated unexpectedly'), { code: '57P01' });
    },
    () => calls.length,
  );
  const result = await runWorkItem(pool, estimated({ effortHours: 1, tokenEstimate: 1000 }), agents, {
    cwd: '/r',
    timeoutMs: 1,
    execute,
  });
  assert.equal(result, 'failed');
  assert.deepEqual(calls, []);
  const record = queries.find((query) => query.sql.includes('WITH step AS') && query.sql.includes('retry_after'));
  assert.match(String(record?.values[1]), /nicht mit der Schätzung vergleichen \(Connection terminated unexpectedly\)/);
  assert.equal(record?.values[8], BUDGET_CHECK_RETRY_MS / 1000);
  assert.ok(queries.some((query) => query.sql.includes("SET status = 'planned'")));
});

test('Budget erreicht blockiert weiterhin wie bisher, unabhängig von der Überschreitungsprüfung', async () => {
  const { calls, execute } = recorder();
  const { pool, queries } = fakePool(
    () => ({ ms: 0, tokens: 1e9 }),
    () => calls.length,
    (sql) => {
      if (sql.includes('FROM budgets')) return { rows: [{ period: 'order', maxTokens: '10', maxCostUsd: null }] };
      if (sql.includes('budget_since::text')) return { rows: [{ tokens: '50', cost: '0', since: null }] };
      // Warnung ab 80 % gilt als schon gemeldet (keine Push-Nachricht im Test).
      if (sql.includes('INSERT INTO budget_warnings')) return { rows: [] };
      return null;
    },
  );
  await runWorkItem(pool, estimated({ effortHours: 1, tokenEstimate: 1000 }), agents, {
    cwd: '/r',
    timeoutMs: 1,
    execute,
  });
  assert.deepEqual(calls, []);
  const blocked = queries.find((query) => query.sql.includes('budget_blocked = $3'));
  assert.deepEqual(blocked?.values.slice(2), ['order', null], 'Budget-Sperre wie bisher');
  assert.ok(!queries.some((query) => String(query.values[1]).startsWith(OVERRUN_TODO_PREFIX)));
});

test('Ein von Hand gestarteter Einzel-Agent ist selbst eine Freigabe und wird nicht geprüft', async () => {
  const { calls, execute } = recorder();
  const { pool, queries } = fakePool(
    () => ({ ms: 0, tokens: 1e9 }),
    () => calls.length,
  );
  await runWorkItem(pool, { ...estimated({ effortHours: 1, tokenEstimate: 1000 }), agentId: 'dev-id' }, agents, {
    cwd: '/r',
    timeoutMs: 1,
    execute,
  });
  assert.ok(!queries.some((query) => isEffortQuery(query.sql)));
});

test('Hinweistext: nur geschätzte Werte, Schätzung ohne Werte gilt nicht', () => {
  assert.equal(rawEstimate({ effortHours: null, tokenEstimate: null }), null);
  assert.equal(rawEstimate({ effortHours: 0, tokenEstimate: 0 }), null);
  assert.deepEqual(rawEstimate({ effortHours: null, tokenEstimate: '2500' as unknown as number }), {
    hours: null,
    tokens: 2500,
  });
  const state = {
    actual: { hours: 2.25, tokens: 9_200_000 },
    estimate: { hours: null, tokens: 2_600_000 },
    exceeded: { hours: false, tokens: true },
  };
  assert.deepEqual(describeOverrun(state), { actual: '9,2 Mio. Tokens', estimate: '2,6 Mio. Tokens' });
  assert.equal(
    overrunTodo(state),
    'Schätzung überschritten: Ist 9,2 Mio. Tokens, Schätzung 2,6 Mio. Tokens – prüfen, dann „Erneut versuchen“',
  );
});
