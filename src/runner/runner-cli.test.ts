import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { describeError, recoverInterruptedRuns, resolveTargets } from './runner-cli.js';
import type { RunnerOptions } from './runner.js';

// Charakterisierung von runner-cli.ts: Wiederherstellung nach Neustart und Auflösen der Projektordner.

function fakePool(projects: { slug: string; repository: string; separate: boolean }[] = []) {
  const queries: string[] = [];
  const params: unknown[][] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push(sql.replace(/\s+/g, ' ').trim());
      params.push(values);
      if (sql.includes('FROM projects')) return { rows: projects, rowCount: projects.length };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, queries, params };
}

const options = {
  project: 'mainty',
  cwd: '/repo',
  limit: 1,
  timeoutMs: 60_000,
  watch: true,
  all: true,
  intervalMs: 30_000,
} as unknown as RunnerOptions;

test('recoverInterruptedRuns: plant unterbrochene Aufträge neu, bevor die Läufe als gescheitert gelten', async () => {
  const { pool, queries, params } = fakePool();
  await recoverInterruptedRuns(pool);
  const index = (part: string): number => queries.findIndex((sql) => sql.includes(part));
  const requeue = index("UPDATE development_items SET status = 'planned'");
  const steps = index("UPDATE agent_run_steps SET status = 'failed'");
  const runs = index("UPDATE agent_runs SET status = 'failed'");
  assert.ok(requeue >= 0 && steps >= 0 && runs >= 0, queries.join('\n'));
  // Erst neu einplanen (braucht die noch laufenden Läufe), dann Schritte und Läufe beenden.
  assert.ok(requeue < runs && steps < runs);
  assert.match(queries[steps] ?? '', /Unterbrochen: Der Worker wurde beendet/);
  assert.ok(index("UPDATE test_requests SET status = 'failed'") >= 0, 'Testanforderungen gelten als abgebrochen');
  assert.ok(index("UPDATE acceptance_checks SET status = 'verifying'") >= 0);
  // Ohne verwaiste Prozesse gehen unterbrochene Chat-Anfragen zurück auf „pending“ (Status als Parameter).
  const chat = index('UPDATE chat_messages SET status = $1');
  assert.ok(chat >= 0);
  assert.deepEqual(params[chat], ['pending']);
  assert.ok(index("UPDATE ideation_items SET status = 'requested'") >= 0);
});

test('resolveTargets: ohne --all genau das angegebene Projekt', async () => {
  const { pool, queries } = fakePool();
  const targets = await resolveTargets(pool, { ...options, all: false });
  assert.deepEqual(targets, [
    { options: { ...options, all: false }, problem: null, repository: '/repo', transient: false },
  ]);
  assert.equal(queries.length, 0);
});

test('resolveTargets: fehlende, getrennte und gesperrte Projektordner bekommen eine Meldung statt Agents', async () => {
  const { pool } = fakePool([
    { slug: 'relativ', repository: 'projekte/relativ', separate: false },
    { slug: 'fehlt', repository: '/opt/gibt-es-nicht-7391', separate: false },
    { slug: 'laufwerk', repository: '/Volumes/Fehlt7391/projekt', separate: false },
    { slug: 'system', repository: '/etc/projekt', separate: false },
  ]);
  const targets = await resolveTargets(pool, options);
  const bySlug = new Map(targets.map((target) => [target.options.project, target]));
  assert.match(bySlug.get('relativ')?.problem ?? '', /Projektordner nicht gefunden: projekte\/relativ/);
  assert.equal(bySlug.get('relativ')?.options.cwd, '/repo', 'ohne Ordner bleibt der Standardordner');
  assert.match(bySlug.get('fehlt')?.problem ?? '', /Projektordner nicht gefunden/);
  assert.equal(bySlug.get('fehlt')?.transient, false);
  // Externes Laufwerk getrennt: nur vorübergehend, Anfragen warten.
  assert.equal(bySlug.get('laufwerk')?.transient, true);
  assert.match(bySlug.get('laufwerk')?.problem ?? '', /Laufwerk „Fehlt7391“ ist nicht verbunden/);
  assert.match(bySlug.get('system')?.problem ?? '', /^Projekt ausserhalb des Projektbereichs/);
  assert.equal(bySlug.get('system')?.transient, false);
});

test('describeError: Text, sonst Code (pg ohne Meldung), sonst Name', () => {
  assert.equal(describeError(new Error('kaputt')), 'kaputt');
  assert.equal(describeError(Object.assign(new Error(''), { code: 'ECONNREFUSED' })), 'ECONNREFUSED');
  assert.equal(describeError(new TypeError('')), 'TypeError');
  assert.equal(describeError('nur Text'), 'nur Text');
});
