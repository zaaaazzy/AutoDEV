import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import type { CommandExecutor } from '../core/command.js';
import { PRE_SPRINT_ATTEMPTS, PRE_SPRINT_RETRY_MS, preSprintRetryAt, runPreSprint } from './pre-sprint.js';
import type { WorkflowAgent } from './runner-types.js';

const planner: WorkflowAgent = {
  id: 'plan-id',
  name: 'Planer',
  role: 'custom',
  phase: 'pre_sprint',
  position: 1,
  instructions: 'Prüfe den Sprint',
  command: ['plan'],
};
const options = { project: 'mainty', cwd: '/r', timeoutMs: 1000 };
const start = new Date(2026, 9, 28, 12, 0);
const at = (ms: number) => () => new Date(start.getTime() + ms);

/** Aktiver Sprint ohne Phase „Vor dem Sprint“; Versuche und nächster Zeitpunkt stehen wie in der DB am Sprint. */
function fakePool(sprintId: string, budgetExceeded = () => false) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const sprint = { attempts: 0, nextAt: null as Date | null };
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('pre_sprint_at IS NULL'))
        return { rows: [{ id: sprintId, name: 'Sprint 1', goal: null, ...sprint }] };
      if (sql.includes('SET pre_sprint_attempts = $2')) {
        sprint.attempts = values[1] as number;
        sprint.nextAt = values[2] as Date;
      } else if (sql.includes('SET pre_sprint_next_at = $2')) sprint.nextAt = values[1] as Date;
      if (sql.includes('FROM agents WHERE project_slug = $1 AND id = $2'))
        return { rows: [{ instructions: 'Prüfe', command: ['plan'], allowedCommands: null, fileScope: null }] };
      if (sql.includes('FROM budgets'))
        return { rows: budgetExceeded() ? [{ period: 'day', maxTokens: '1000', maxCostUsd: null }] : [] };
      if (sql.includes('to_char(CURRENT_DATE')) return { rows: [{ key: '2026-10-20', since: '2026-10-20' }] };
      if (sql.includes('FROM agent_run_steps s JOIN agent_runs r')) return { rows: [{ tokens: '1500', cost: '0' }] };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const finished = () => queries.filter((query) => query.sql.includes('SET pre_sprint_at = NOW()'));
  return { pool, queries, finished, sprint };
}

function counting(output: (call: number) => { exitCode: number; output: string }) {
  let calls = 0;
  const execute: CommandExecutor = async () => {
    calls += 1;
    return { durationMs: 1, ...output(calls) };
  };
  return { execute, calls: () => calls };
}

test('Wartezeit wächst mit jedem Fehlversuch', () => {
  assert.equal(preSprintRetryAt(1, start).getTime() - start.getTime(), PRE_SPRINT_RETRY_MS);
  assert.equal(preSprintRetryAt(2, start).getTime() - start.getTime(), 2 * PRE_SPRINT_RETRY_MS);
});

test('Vor dem Sprint gescheitert: Wiederholung erst nach wachsender Pause, Fehlertext nie als Sprint-Hinweis', async () => {
  const { pool, finished, sprint } = fakePool('sprint-retry');
  const { execute, calls } = counting(() => ({ exitCode: 1, output: 'Fehler: Ollama nicht erreichbar' }));
  let elapsed = 0;
  for (let attempt = 1; attempt < PRE_SPRINT_ATTEMPTS; attempt += 1) {
    assert.equal(await runPreSprint(pool, options, [planner], execute, at(elapsed)), true);
    assert.equal(finished().length, 0, `Versuch ${attempt}: Phase gilt nicht als erledigt`);
    assert.equal(sprint.attempts, attempt, 'Versuche stehen am Sprint, nicht im Speicher');
    const wait = sprint.nextAt!.getTime() - start.getTime() - elapsed;
    // Im nächsten Zyklus (30 s) läuft nichts; die Aufträge warten, solange Versuche übrig sind.
    assert.equal(await runPreSprint(pool, options, [planner], execute, at(elapsed + 30_000)), true);
    assert.equal(calls(), attempt, `Versuch ${attempt}: Pause abwarten`);
    elapsed += wait;
  }
  // Letzter Versuch: die Aufträge starten ohne die Phase, ohne die Fehlermeldung als Hinweis.
  assert.equal(await runPreSprint(pool, options, [planner], execute, at(elapsed)), true);
  assert.equal(calls(), PRE_SPRINT_ATTEMPTS);
  assert.equal(finished().length, 1);
  assert.equal(finished()[0]?.values[1], null);
});

test('Vor dem Sprint: ein kurzer Ausfall (zwei Minuten) verbraucht nicht alle Versuche', async () => {
  const { pool, finished, sprint } = fakePool('sprint-outage');
  const outageMs = 2 * 60_000;
  let now = 0;
  const { execute } = counting(() =>
    now < outageMs ? { exitCode: 1, output: 'Fehler: Ollama nicht erreichbar' } : { exitCode: 0, output: 'Passt.' },
  );
  // Worker-Zyklus alle 30 s, bis die Phase erledigt ist.
  for (; now <= 10 * 60_000 && !finished().length; now += 30_000) {
    await runPreSprint(pool, options, [planner], execute, at(now));
  }
  assert.equal(finished().length, 1);
  assert.match(String(finished()[0]?.values[1]), /Passt\./);
  assert.ok(sprint.attempts < PRE_SPRINT_ATTEMPTS);
});

test('Vor dem Sprint am Nutzungslimit: kein Fehlversuch, kein Hinweis, Nachholen nach dem Reset', async () => {
  const { pool, finished, sprint } = fakePool('sprint-limit');
  const limit =
    "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage · your session limit resets 8:50pm (Europe/Zurich)";
  const { execute, calls } = counting(() => ({ exitCode: 1, output: limit }));
  // Aufträge blockiert die Phase dabei nicht: Sie laufen in ihre eigene Limit-Behandlung.
  assert.equal(await runPreSprint(pool, options, [planner], execute, at(0)), false);
  assert.equal(sprint.attempts, 0);
  // 20:50 Uhr in Zürich (MEZ) = 19:50 UTC, plus drei Minuten Reserve.
  assert.equal(sprint.nextAt?.toISOString().slice(11, 16), '19:53');
  assert.equal(finished().length, 0);
  assert.equal(await runPreSprint(pool, options, [planner], execute, at(60 * 60_000)), false);
  assert.equal(calls(), 1, 'vor dem Reset kein neuer Aufruf');
  const ok = counting(() => ({ exitCode: 0, output: 'Reihenfolge passt.' }));
  const afterReset = () => new Date(sprint.nextAt!.getTime() + 1);
  assert.equal(await runPreSprint(pool, options, [planner], ok.execute, afterReset), true);
  assert.match(String(finished()[0]?.values[1]), /Reihenfolge passt\./);
  assert.doesNotMatch(String(finished()[0]?.values[1]), /spend limit/);
});

test('Vor dem Sprint erfolgreich: Ergebnis wird Sprint-Hinweis', async () => {
  const { pool, finished } = fakePool('sprint-ok');
  const ok: CommandExecutor = async () => ({ exitCode: 0, durationMs: 1, output: 'Reihenfolge passt.' });
  assert.equal(await runPreSprint(pool, options, [planner], ok), true);
  assert.match(String(finished()[0]?.values[1]), /### Planer\nReihenfolge passt\./);
});

test('Vor dem Sprint bei erreichtem Budget: nichts läuft, die Phase wird später nachgeholt', async () => {
  const { pool, finished } = fakePool('sprint-budget', () => true);
  const { execute, calls } = counting(() => ({ exitCode: 0, output: '' }));
  assert.equal(await runPreSprint(pool, options, [planner], execute), false);
  assert.equal(calls(), 0);
  assert.equal(finished().length, 0);
});
