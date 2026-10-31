import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { treeLockName } from '../core/project-lock.js';
import { holdWorkerLock, recoverInterruptedRuns } from './runner-cli.js';
import { describeError } from './worker-log.js';
import { folderInUseBy, resolveTargets } from './worker-targets.js';
import pg from 'pg';
import { adminPool, ADMIN_URL } from '../db/test-database.test.js';
import type { RunnerOptions } from './runner.js';

test('Ein Ordner, ein Auftrag: zweites Projekt im selben echten Ordner (auch per Symlink) startet nicht', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'runner-folder-'));
  const other = await mkdtemp(join(tmpdir(), 'runner-other-'));
  const link = `${folder}-link`;
  await symlink(folder, link);
  const running = new Map([['projekt-a', treeLockName(folder)]]);
  assert.equal(folderInUseBy(link, running), 'projekt-a');
  assert.equal(folderInUseBy(`${folder}/.`, running), 'projekt-a');
  assert.equal(folderInUseBy(other, running), null);
  assert.equal(folderInUseBy(folder, new Map()), null);
});

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
  // Kennzeichen „unterbrochen“: der nächste Lauf setzt beim selben Agent fort, nicht beim Entwickler.
  assert.match(queries[steps] ?? '', /interrupted = TRUE/);
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

/** Verbindung mit Advisory-Lock: zählt Abfragen und Freigaben. */
function lockClient(locked: boolean) {
  const calls: string[] = [];
  let released: unknown = 'nein';
  const listeners = new Set<unknown>();
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      return { rows: [{ ok: locked }] };
    },
    release: (error?: unknown) => {
      released = error ?? 'ok';
    },
    on: (_event: string, listener: unknown) => listeners.add(listener),
    off: (_event: string, listener: unknown) => listeners.delete(listener),
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, calls, released: () => released, listeners };
}

test('Worker-Sperre: gibt die Verbindung beim Beenden frei, sonst hängt pool.end()', async () => {
  const held = lockClient(true);
  const release = await holdWorkerLock(held.pool);
  assert.ok(release);
  assert.equal(held.released(), 'nein', 'solange der Worker läuft, bleibt die Verbindung ausgeliehen');
  await release();
  await release();
  assert.equal(held.released(), 'ok');
  assert.equal(held.calls.filter((sql) => sql.includes('pg_advisory_unlock')).length, 1, 'nur einmal freigeben');
  assert.equal(held.listeners.size, 0);

  const taken = lockClient(false);
  assert.equal(await holdWorkerLock(taken.pool), null, 'ein anderer Worker hält die Sperre');
  assert.equal(taken.released(), 'ok');
});

test('Worker-Sperre auf PostgreSQL: nach der Freigabe endet pool.end() sofort', async (t) => {
  const admin = await adminPool(t);
  if (!admin) return;
  await admin.end();
  const pool = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  const release = await holdWorkerLock(pool);
  if (!release) {
    // Auf diesem Rechner läuft der echte Worker und hält die Sperre: dann nur prüfen, dass nichts ausgeliehen bleibt.
    await pool.end();
    return;
  }
  await release();
  const ended = await Promise.race([
    pool.end().then(() => 'beendet'),
    new Promise((resolve) => setTimeout(() => resolve('hängt'), 3_000)),
  ]);
  assert.equal(ended, 'beendet');
});
