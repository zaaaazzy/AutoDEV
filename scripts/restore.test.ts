import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

// scripts/restore.sh mit Stub-docker und Stub-Schlüssel-Test: jeder Aufruf landet im Log, nichts läuft wirklich.
const SCRIPT = resolve(import.meta.dirname, 'restore.sh');
const KEY = 'restore-test-schluessel-0123456789';

const DOCKER_STUB = `#!/bin/sh
echo "docker $*" >> "$STUB_LOG"
case "$*" in
  *"ps --status running --services"*) echo db ;;
  *"pg_restore --list"*) cat >/dev/null; exit "\${STUB_LIST_EXIT:-0}" ;;
  *pg_restore*) cat >/dev/null; exit "\${STUB_RESTORE_EXIT:-0}" ;;
  *-tAc*) echo "\${STUB_SUMMARY:-t|42}" ;;
esac
exit 0
`;

// Prüft nur, ob der richtige Schlüssel ankommt – gibt ihn nie aus.
const KEY_CHECK_STUB = `#!/bin/sh
if [ "$DEV_LOG_SECRET_KEY" = "$STUB_EXPECTED_KEY" ]; then state=ok; else state=falsch; fi
echo "key-check $DEV_LOG_CHECK_DATABASE_URL key=$state" >> "$STUB_LOG"
exit "\${STUB_KEY_EXIT:-0}"
`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dev-log-restore-'));
  const bin = join(root, 'bin');
  const backups = join(root, 'backups');
  mkdirSync(bin);
  mkdirSync(backups);
  writeFileSync(join(bin, 'docker'), DOCKER_STUB);
  writeFileSync(join(bin, 'key-check'), KEY_CHECK_STUB);
  chmodSync(join(bin, 'docker'), 0o755);
  chmodSync(join(bin, 'key-check'), 0o755);
  const dump = join(backups, 'aideation-20261027-030001.dump');
  writeFileSync(dump, 'PGDMP-stub');
  writeFileSync(join(backups, 'aideation-20261026-030001.dump'), 'PGDMP-alt');
  return { root, bin, backups, dump, log: join(root, 'calls.log') };
}

type Ctx = ReturnType<typeof setup>;

function run(ctx: Ctx, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    input: '',
    env: {
      PATH: `${ctx.bin}:/usr/bin:/bin`,
      // Eigenes HOME: keine echten launchd-/systemd-Dienste und keine worker.env.
      HOME: ctx.root,
      XDG_CONFIG_HOME: join(ctx.root, 'config'),
      STUB_LOG: ctx.log,
      STUB_EXPECTED_KEY: KEY,
      RESTORE_KEY_CHECK: join(ctx.bin, 'key-check'),
      DEV_LOG_SECRET_KEY: KEY,
      DEV_LOG_DB_USER: 'devlog',
      DEV_LOG_DATABASE_URL: 'postgresql://devlog:pw@localhost:5433/aideation',
      ...env,
    },
  });
  const calls = existsSync(ctx.log) ? readFileSync(ctx.log, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { ...result, calls };
}

function withCtx(t: { after: (fn: () => void) => void }): Ctx {
  const ctx = setup();
  t.after(() => rmSync(ctx.root, { recursive: true, force: true }));
  return ctx;
}

/** Index des ersten Aufrufs, der alle Teile enthält (-1 = keiner). */
const callIndex = (calls: string[], ...parts: string[]) =>
  calls.findIndex((call) => parts.every((part) => call.includes(part)));

function assertKeyNeverPrinted(result: ReturnType<typeof run>) {
  for (const text of [result.stdout, result.stderr, ...result.calls]) assert.ok(!text.includes(KEY), 'Schlüssel ausgegeben');
}

test('restore.sh: fehlende Backup-Datei = klarer Fehler, kein docker-Aufruf', (t) => {
  const ctx = withCtx(t);
  const result = run(ctx, ['--probe', join(ctx.backups, 'gibt-es-nicht.dump')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fehlt oder ist nicht lesbar/);
  assert.deepEqual(result.calls, []);
});

for (const [env, reason] of [
  [{ RESTORE_PROBE_NAME: 'aideation' }, /keine Wegwerf-Datenbank/],
  [{ RESTORE_PROBE_NAME: 'dev_log_e2e' }, /keine Wegwerf-Datenbank/],
  [{ RESTORE_PROBE_NAME: 'shop' }, /aideation_restore_probe_/],
  [{ RESTORE_PROBE_PORT: '5433' }, /Live-Datenbank/],
  [{ RESTORE_PROBE_PORT: '6543', DEV_LOG_DATABASE_URL: 'postgresql://devlog:pw@localhost:6543/aideation' }, /Live/],
] as const) {
  test(`restore.sh --probe lehnt die Live-Datenbank als Ziel ab: ${JSON.stringify(env)}`, (t) => {
    const ctx = withCtx(t);
    const result = run(ctx, ['--probe', ctx.dump], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, reason);
    assert.equal(callIndex(result.calls, 'docker run'), -1, 'kein Container gestartet');
    assert.equal(callIndex(result.calls, 'pg_restore'), -1);
  });
}

test('restore.sh --probe: Wegwerf-Container auf eigenem Port, --exit-on-error, Schlüssel-Test, danach gelöscht', (t) => {
  const ctx = withCtx(t);
  const result = run(ctx, ['--probe', ctx.dump]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Restore-Probe bestanden: aideation-20261027-030001\.dump .*42 Tabellen/);
  const start = callIndex(result.calls, 'docker run -d --rm --name aideation_restore_probe_');
  assert.ok(start >= 0, result.calls.join('\n'));
  assert.match(result.calls[start]!, /-p 127\.0\.0\.1:5439:5432/);
  assert.match(result.calls[start]!, /-e POSTGRES_PASSWORD -e/, 'Passwort nur über die Umgebung');
  const restore = callIndex(result.calls, 'pg_restore', '--exit-on-error', '--single-transaction');
  assert.ok(restore > start);
  assert.match(result.calls[restore]!, /-d aideation_restore_probe_/);
  const keyCheck = callIndex(result.calls, 'key-check postgresql://postgres:', '@127.0.0.1:5439/aideation_restore_probe_');
  assert.ok(keyCheck > restore);
  assert.match(result.calls[keyCheck]!, /key=ok/);
  assert.match(result.calls.at(-1)!, /^docker rm -f aideation_restore_probe_/);
  assert.equal(callIndex(result.calls, 'docker compose'), -1, 'Live-Stack bleibt unberührt');
  assertKeyNeverPrinted(result);
});

test('restore.sh --probe: scheitert pg_restore, wird der Container trotzdem entfernt und kein Backup gelöscht', (t) => {
  const ctx = withCtx(t);
  const before = readdirSync(ctx.backups).sort();
  const result = run(ctx, ['--probe', ctx.dump], { STUB_RESTORE_EXIT: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Einspielen von aideation-20261027-030001\.dump fehlgeschlagen/);
  assert.equal(callIndex(result.calls, 'key-check'), -1);
  assert.match(result.calls.at(-1)!, /^docker rm -f aideation_restore_probe_/);
  assert.deepEqual(readdirSync(ctx.backups).sort(), before);
});

test('restore.sh --probe: falscher Schlüssel oder fremde Datenbank = Fehler', (t) => {
  const ctx = withCtx(t);
  const wrongKey = run(ctx, ['--probe', ctx.dump], { STUB_KEY_EXIT: '1' });
  assert.equal(wrongKey.status, 1);
  assert.match(wrongKey.stderr, /Schlüssel-Test fehlgeschlagen/);
  assert.match(wrongKey.calls.at(-1)!, /^docker rm -f aideation_restore_probe_/);
  assertKeyNeverPrinted(wrongKey);
  rmSync(ctx.log, { force: true });
  const foreign = run(ctx, ['--probe', ctx.dump], { STUB_SUMMARY: 'f|3' });
  assert.equal(foreign.status, 1);
  assert.match(foreign.stderr, /keine AIdeation-Tabellen/);
});

test('restore.sh (Ernstfall): ohne --yes und ohne Terminal wird nichts gestoppt', (t) => {
  const ctx = withCtx(t);
  const result = run(ctx, [ctx.dump]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nur mit --yes/);
  assert.equal(callIndex(result.calls, ' stop '), -1);
  assert.equal(callIndex(result.calls, 'CREATE DATABASE'), -1);
});

test('restore.sh (Ernstfall): unlesbarer Dump (pg_restore --list) bricht vor dem Stoppen ab', (t) => {
  const ctx = withCtx(t);
  const result = run(ctx, ['--yes', ctx.dump], { STUB_LIST_EXIT: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /kein lesbares Backup/);
  assert.equal(callIndex(result.calls, ' stop '), -1);
});

test('restore.sh (Ernstfall): stoppen → neue Datenbank → Schlüssel-Test → umbenennen → starten', (t) => {
  const ctx = withCtx(t);
  const before = readdirSync(ctx.backups).sort();
  const result = run(ctx, ['--yes', ctx.dump]);
  assert.equal(result.status, 0, result.stderr);
  const steps = [
    callIndex(result.calls, 'pg_restore --list'),
    callIndex(result.calls, 'stop dev-log frontend backup'),
    callIndex(result.calls, 'CREATE DATABASE aideation_restore_'),
    callIndex(result.calls, 'pg_restore --exit-on-error --single-transaction', '-d aideation_restore_'),
    callIndex(result.calls, 'key-check postgresql://devlog:pw@localhost:5433/aideation_restore_', 'key=ok'),
    callIndex(result.calls, 'ALTER DATABASE aideation RENAME TO aideation_vor_restore_'),
    callIndex(result.calls, 'ALTER DATABASE aideation_restore_', 'RENAME TO aideation'),
    callIndex(result.calls, 'start backup dev-log frontend'),
  ];
  assert.ok(steps.every((step) => step >= 0), result.calls.join('\n'));
  assert.deepEqual([...steps].sort((a, b) => a - b), steps, 'Reihenfolge');
  assert.equal(callIndex(result.calls, '--clean'), -1, 'nie --clean gegen die laufende Datenbank');
  assert.match(result.stdout, /Bisherige Datenbank: aideation_vor_restore_/);
  assert.deepEqual(readdirSync(ctx.backups).sort(), before, 'Backups bleiben unverändert');
  assertKeyNeverPrinted(result);
});

for (const [env, reason] of [
  [{ STUB_RESTORE_EXIT: '1' }, /Einspielen fehlgeschlagen/],
  [{ STUB_KEY_EXIT: '1' }, /Schlüssel-Test fehlgeschlagen/],
] as const) {
  test(`restore.sh (Ernstfall): ${JSON.stringify(env)} → Live-Datenbank unverändert, Dienste starten wieder`, (t) => {
    const ctx = withCtx(t);
    const result = run(ctx, ['--yes', ctx.dump], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, reason);
    assert.match(result.stderr, /Live-Datenbank unverändert/);
    assert.equal(callIndex(result.calls, 'RENAME TO'), -1, 'nichts umbenannt');
    assert.ok(callIndex(result.calls, 'DROP DATABASE IF EXISTS aideation_restore_') >= 0);
    assert.match(result.calls.at(-1)!, /start backup dev-log frontend/);
  });
}
