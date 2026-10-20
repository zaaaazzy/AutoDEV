import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DATABASE_COPY_SCRIPT, reviewDatabase, reviewPort, reviewUrl } from './review-slots.js';
import { orderOf, parseSprintLog } from './sprint-commits.js';

test('Review-Container: Port und Adresse je Nummer', () => {
  assert.equal(reviewPort(1), 4201);
  assert.equal(reviewUrl(3), 'http://localhost:4203');
});

test('Datenbank-Kopie je Container, aus Docker über host.docker.internal erreichbar', () => {
  const copy = reviewDatabase('postgresql://mainty:geheim@127.0.0.1:5432/mainty', 2);
  assert.equal(copy?.source.toString(), 'postgresql://mainty:geheim@host.docker.internal:5432/mainty');
  assert.equal(copy?.target.toString(), 'postgresql://mainty:geheim@host.docker.internal:5432/mainty_review_2');
  assert.equal(reviewDatabase('postgresql://db.example:5432/app', 1)?.target.hostname, 'db.example');
  assert.equal(reviewDatabase('kein url', 1), null);
});

test('Sprint-Stände: Git-Log lesen und Auftrag aus dem Merge erkennen', () => {
  const hash = 'a'.repeat(40);
  const log = `${hash}\x1fMerge auftrag/1a2b3c4d-liste: Liste\x1f2026-10-19T20:00:00+02:00\x1e\nkaputt\x1e`;
  assert.deepEqual(parseSprintLog(log), [
    { hash, subject: 'Merge auftrag/1a2b3c4d-liste: Liste', date: '2026-10-19T20:00:00+02:00' },
  ]);
  const items = [{ id: '1a2b3c4d-0000-0000-0000-000000000000' }, { id: 'ffffffff-0000-0000-0000-000000000000' }];
  assert.equal(orderOf('Merge auftrag/1a2b3c4d-liste: Liste', items), items[0]!.id);
  assert.equal(orderOf('feat: ohne Auftrag', items), null);
});

/** Führt das Kopier-Skript mit Platzhaltern für die Postgres-Werkzeuge aus; liefert Exit-Code und psql-Aufrufe. */
async function runCopyScript(dumpExit: number, psqlExit = 0): Promise<{ status: number | null; psql: string }> {
  const bin = await mkdtemp(join(tmpdir(), 'review-db-'));
  const log = join(bin, 'psql.log');
  const tool = async (name: string, body: string) => {
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  };
  await tool('dropdb', 'exit 0');
  await tool('createdb', 'exit 0');
  await tool('pg_dump', `[ ${dumpExit} -eq 0 ] && echo 'CREATE TABLE a ();' > "$3"; exit ${dumpExit}`);
  await tool('psql', `echo "$@" >> '${log}'; exit ${psqlExit}`);
  const result = spawnSync('sh', ['-c', DATABASE_COPY_SCRIPT], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, S_DB: 'quelle', T_DB: 'ziel' },
  });
  return { status: result.status, psql: await readFile(log, 'utf8').catch(() => '') };
}

test('Datenbank-Kopie: gescheiterter pg_dump lässt die Kopie scheitern statt eine leere Datenbank zu melden', async () => {
  const failed = await runCopyScript(1);
  assert.notEqual(failed.status, 0);
  assert.equal(failed.psql, '', 'psql spielt nach einem gescheiterten Dump nichts ein');
  const sqlError = await runCopyScript(0, 3);
  assert.notEqual(sqlError.status, 0);
  assert.match(sqlError.psql, /ON_ERROR_STOP=1/);
  const ok = await runCopyScript(0);
  assert.equal(ok.status, 0);
  assert.match(ok.psql, /-d ziel -f /);
});
