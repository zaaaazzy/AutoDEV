import assert from 'node:assert/strict';
import test from 'node:test';
import type { OrphanResult } from '../core/shutdown.js';
import { databaseProcessStore, killPreviousProcesses } from './process-registry.js';

interface Query {
  sql: string;
  params: unknown[];
}

function fakePool(rows: { pid: number; startedAt: Date }[] = []) {
  const queries: Query[] = [];
  return {
    queries,
    query: (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return Promise.resolve({ rows: sql.trim().startsWith('SELECT') ? rows : [], rowCount: 0 });
    },
  };
}

test('Prozessregister: Anlegen und Löschen landen in Startreihenfolge in agent_processes', async () => {
  const pool = fakePool();
  const store = databaseProcessStore(pool as never, 'host:/aideation:alle');
  const entry = { pid: 4242, startedAt: new Date(), command: 'claude', cwd: '/tmp/projekt' };
  store.add(entry);
  store.remove(entry);
  await store.flush();
  assert.match(pool.queries[0].sql, /^INSERT INTO agent_processes/);
  // Mit Worker-ID: Ein zweiter Worker beendet den Prozess beim Start nicht, solange dieser Worker lebt.
  assert.deepEqual(pool.queries[0].params, [4242, entry.startedAt, 'claude', '/tmp/projekt', 'host:/aideation:alle']);
  assert.match(pool.queries[1].sql, /^DELETE FROM agent_processes/);
  assert.deepEqual(pool.queries[1].params, [4242, entry.startedAt]);
});

test('Start-Aufräumen liest auch Chat-, Autor- und Visionär-Prozesse, nicht nur agent_run_steps', async () => {
  const startedAt = new Date('2026-10-21T10:00:00Z');
  const pool = fakePool([{ pid: 100, startedAt }]);
  const killed: number[] = [];
  const result = await killPreviousProcesses(pool as never, (pid) => {
    killed.push(pid);
    return 'killed';
  });
  assert.match(pool.queries[0].sql, /FROM agent_processes/);
  assert.match(pool.queries[0].sql, /FROM agent_run_steps/);
  // Besitzprüfung: nur eigene oder verwaiste Prozesse (Worker ohne frisches Lebenszeichen).
  assert.match(pool.queries[0].sql, /FROM runner_workers/);
  assert.deepEqual(killed, [100]);
  assert.deepEqual(result, { killed: 1, failed: 0 });
  assert.ok(pool.queries.some((query) => /^DELETE FROM agent_processes/.test(query.sql)));
});

test('lässt sich ein Altprozess nicht sicher beenden, bleibt sein Eintrag und der Fehler wird gezählt', async () => {
  const outcomes: Record<number, OrphanResult> = { 1: 'failed', 2: 'reused', 3: 'gone' };
  const pool = fakePool([1, 2, 3].map((pid) => ({ pid, startedAt: new Date() })));
  const result = await killPreviousProcesses(pool as never, (pid) => outcomes[pid]);
  assert.deepEqual(result, { killed: 0, failed: 1 });
  const deleted = pool.queries.filter((query) => query.sql.startsWith('DELETE')).map((query) => query.params[0]);
  assert.deepEqual(deleted, [2, 3]);
});
