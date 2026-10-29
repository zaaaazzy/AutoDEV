import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

// deploy/backup.sh mit Stub-pg_dump: ein Durchlauf (BACKUP_ONCE=1) in einem eigenen Ordner statt /backups.
const SCRIPT = resolve(import.meta.dirname, '..', 'deploy', 'backup.sh');
const DAY = 24 * 60 * 60 * 1000;

function setup(pgDumpOk: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'dev-log-backup-'));
  const dir = join(root, 'backups');
  const bin = join(root, 'bin');
  mkdirSync(dir);
  mkdirSync(bin);
  const stub = pgDumpOk
    ? '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = -f ] && { printf dump > "$2"; exit 0; }; shift; done\nexit 1\n'
    : '#!/bin/sh\necho "password authentication failed" >&2\nexit 1\n';
  writeFileSync(join(bin, 'pg_dump'), stub);
  chmodSync(join(bin, 'pg_dump'), 0o755);
  return { root, dir, bin };
}

/** Legt `count` alte Dumps an, der jüngste 20 Tage alt, jeder weitere einen Tag älter. */
function oldDumps(dir: string, count: number) {
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const when = new Date(Date.now() - (20 + i) * DAY);
    const stamp = when.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const name = `aideation-${stamp}.dump`;
    writeFileSync(join(dir, name), 'alt');
    utimesSync(join(dir, name), when, when);
    names.push(name);
  }
  return names;
}

function foreign(dir: string, name: string) {
  const when = new Date(Date.now() - 60 * DAY);
  writeFileSync(join(dir, name), 'fremd');
  utimesSync(join(dir, name), when, when);
}

function run(ctx: { dir: string; bin: string }, env: Record<string, string> = {}) {
  return spawnSync('/bin/sh', [SCRIPT], {
    encoding: 'utf8',
    env: { PATH: `${ctx.bin}:${process.env.PATH}`, BACKUP_DIR: ctx.dir, BACKUP_ONCE: '1', BACKUP_KEEP_DAYS: '14', ...env },
  });
}

test('pg_dump scheitert: keine Rotation, alle alten Backups bleiben', (t) => {
  const ctx = setup(false);
  t.after(() => rmSync(ctx.root, { recursive: true, force: true }));
  const names = oldDumps(ctx.dir, 10);
  const result = run(ctx);
  assert.match(result.stderr, /Backup fehlgeschlagen/);
  const left = readdirSync(ctx.dir);
  for (const name of names) assert.ok(left.includes(name), `${name} wurde trotz fehlgeschlagenem Dump gelöscht`);
  assert.ok(!left.some((name) => name.endsWith('.tmp')), 'Temp-Datei bleibt liegen');
});

test('pg_dump klappt: neueste 7 bleiben, ältere über KEEP_DAYS weg, fremde Dumps unberührt, Rechte 600', (t) => {
  const ctx = setup(true);
  t.after(() => rmSync(ctx.root, { recursive: true, force: true }));
  const names = oldDumps(ctx.dir, 10);
  foreign(ctx.dir, 'fremd-20200101.dump');
  foreign(ctx.dir, 'aideation-handkopie.dump.bak');
  const result = run(ctx);
  assert.equal(result.status, 0, result.stderr);
  const dumps = readdirSync(ctx.dir).filter((name) => /^aideation-\d{8}-\d{6}\.dump$/.test(name));
  const fresh = dumps.filter((name) => !names.includes(name));
  assert.equal(fresh.length, 1, 'neues Backup fehlt');
  assert.equal(statSync(join(ctx.dir, fresh[0])).mode & 0o777, 0o600);
  // Neues Backup + die sechs jüngsten alten; die vier ältesten (alle über 14 Tage) sind gelöscht.
  assert.deepEqual(dumps.sort(), [...fresh, ...names.slice(0, 6)].sort());
  assert.ok(existsSync(join(ctx.dir, 'fremd-20200101.dump')));
  assert.ok(existsSync(join(ctx.dir, 'aideation-handkopie.dump.bak')));
});

test('pg_dump klappt: jüngere Backups als KEEP_DAYS bleiben auch über der Mindestanzahl', (t) => {
  const ctx = setup(true);
  t.after(() => rmSync(ctx.root, { recursive: true, force: true }));
  const names = oldDumps(ctx.dir, 10);
  const result = run(ctx, { BACKUP_KEEP_DAYS: '60' });
  assert.equal(result.status, 0, result.stderr);
  for (const name of names) assert.ok(existsSync(join(ctx.dir, name)), `${name} ist jünger als 60 Tage`);
});

for (const value of ['abc', '0', '-3', '']) {
  test(`ungültige BACKUP_MIN_KEEP=${JSON.stringify(value)}: Standard 7 statt alles löschen`, (t) => {
    const ctx = setup(true);
    t.after(() => rmSync(ctx.root, { recursive: true, force: true }));
    const names = oldDumps(ctx.dir, 10);
    const result = run(ctx, { BACKUP_MIN_KEEP: value });
    assert.equal(result.status, 0, result.stderr);
    for (const name of names.slice(0, 6)) assert.ok(existsSync(join(ctx.dir, name)), `${name} fehlt`);
    for (const name of names.slice(6)) assert.ok(!existsSync(join(ctx.dir, name)), `${name} ist noch da`);
  });
}

test('BACKUP_MIN_KEEP=3: nur die neuesten drei bleiben, wenn alle älteren über KEEP_DAYS liegen', (t) => {
  const ctx = setup(true);
  t.after(() => rmSync(ctx.root, { recursive: true, force: true }));
  const names = oldDumps(ctx.dir, 5);
  const result = run(ctx, { BACKUP_MIN_KEEP: '3' });
  assert.equal(result.status, 0, result.stderr);
  const dumps = readdirSync(ctx.dir).filter((name) => name.endsWith('.dump'));
  assert.equal(dumps.length, 3);
  for (const name of names.slice(0, 2)) assert.ok(dumps.includes(name));
});
