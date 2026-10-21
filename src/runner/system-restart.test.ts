import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommandExecutor } from '../core/command.js';
import { completeRestart, processRestart, readRestart, requestRestart, RESTART_COMMAND } from './system-restart.js';

/** app_settings im Speicher: genug für SELECT value … WHERE key und INSERT … ON CONFLICT. */
function memoryPool() {
  const rows = new Map<string, string>();
  return {
    rows,
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith('SELECT')) {
        const value = rows.get(String(values[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      rows.set(String(values[0]), String(values[1]));
      return { rows: [] };
    },
  } as unknown as Parameters<typeof readRestart>[0] & { rows: Map<string, string> };
}

/** Git im Arbeitsordner: Branch main, nichts geändert – sonst die Ausgabe von docker compose. */
const ok: CommandExecutor = async (command) => ({
  exitCode: 0,
  durationMs: 1,
  output: command[0] === 'git' ? (command[1] === 'rev-parse' ? 'main\n' : '') : 'Container dev-log Started',
});

test('Neustart: anfordern, Container neu bauen, nach dem Worker-Start abschließen', async () => {
  const pool = memoryPool();
  const calls: { command: string[]; cwd: string }[] = [];
  const execute: CommandExecutor = async (command, cwd) => {
    calls.push({ command, cwd });
    return ok(command, cwd);
  };
  assert.equal(await processRestart(pool, '/srv/devlog', () => 0, execute), 'idle');
  const first = await requestRestart(pool, 'Patrick');
  assert.equal(first.created, true);
  assert.equal((await requestRestart(pool, 'jemand')).created, false, 'kein zweiter Neustart parallel');
  assert.equal(
    await processRestart(pool, '/srv/devlog', () => 0, execute, undefined, { health: async () => true }),
    'restart',
  );
  assert.deepEqual(
    calls.filter((call) => call.command.includes('--build')),
    [{ command: RESTART_COMMAND, cwd: '/srv/devlog' }],
  );
  assert.equal((await readRestart(pool))?.status, 'restarting');
  assert.equal((await completeRestart(pool))?.status, 'done');
  assert.equal((await requestRestart(pool, 'Patrick')).created, true, 'nach Abschluss wieder möglich');
});

test('Neustart: wartet auf laufende Aufgaben, aber nicht unbegrenzt', async () => {
  const pool = memoryPool();
  const requested = new Date('2026-10-19T10:00:00Z');
  await requestRestart(pool, null, requested);
  const soon = () => new Date(requested.getTime() + 60_000);
  assert.equal(await processRestart(pool, '/x', () => 2, ok, soon), 'waiting');
  assert.match((await readRestart(pool))?.message ?? '', /Wartet auf 2 laufende Aufgaben/);
  const late = () => new Date(requested.getTime() + 16 * 60_000);
  assert.equal(await processRestart(pool, '/x', () => 2, ok, late, { health: async () => true }), 'restart');
});

test('Neustart: fehlgeschlagener Build lässt den Worker weiterlaufen und meldet die Ausgabe', async () => {
  const pool = memoryPool();
  await requestRestart(pool, null);
  const failing: CommandExecutor = async (command, cwd) =>
    command[0] === 'git' ? ok(command, cwd) : { exitCode: 1, durationMs: 1, output: 'failed to solve: npm ci' };
  assert.equal(await processRestart(pool, '/x', () => 0, failing), 'failed');
  const state = await readRestart(pool);
  assert.equal(state?.status, 'failed');
  assert.match(state?.log ?? '', /npm ci/);
  // Ein Worker-Start nach einem abgebrochenen Build markiert diesen als fehlgeschlagen.
  pool.rows.set('system:restart', JSON.stringify({ ...state, status: 'building' }));
  assert.equal((await completeRestart(pool))?.status, 'failed');
});

test('Neustart: Kommentar aus der Bestätigung wird gespeichert', async () => {
  const pool = memoryPool();
  const { state } = await requestRestart(pool, 'Patrick', new Date(), '  neue Agents laden ');
  assert.equal(state.comment, 'neue Agents laden');
});

test('Neustart: antwortet der neue Stand nicht, wird auf das vorherige Abbild zurückgesetzt', async () => {
  const pool = memoryPool();
  const calls: string[][] = [];
  const execute: CommandExecutor = async (command) => {
    calls.push(command);
    if (command.includes('images'))
      return {
        exitCode: 0,
        durationMs: 1,
        output: '[{"ID":"sha256:abc","Repository":"devlog-dev-log","Tag":"latest"}]',
      };
    return ok(command, '/x');
  };
  await requestRestart(pool, 'Patrick');
  let checks = 0;
  // Erst nach dem Zurücksetzen antwortet AIdeation wieder.
  const health = async (): Promise<boolean> => calls.some((call) => call.includes('--no-build')) && ++checks > 0;
  const result = await processRestart(pool, '/srv', () => 0, execute, undefined, {
    health,
    healthTimeoutMs: 0,
    healthIntervalMs: 0,
  });
  assert.equal(result, 'failed');
  assert.ok(calls.some((call) => call.join(' ') === 'docker tag sha256:abc devlog-dev-log:latest'));
  const state = await readRestart(pool);
  assert.match(state?.message ?? '', /vorherigen Abbild/);
});

test('Neustart: meldet das Ende per Benachrichtigung, Erfolg wie Fehlschlag, Zwischenstände nicht', async () => {
  const pool = memoryPool();
  const seen: string[] = [];
  const notify = async (_pool: unknown, state: { status: string }) => {
    seen.push(state.status);
  };
  await requestRestart(pool, 'Patrick');
  await processRestart(pool, '/x', () => 0, ok, undefined, { health: async () => true, notify });
  assert.deepEqual(seen, [], 'building und restarting melden nichts');
  await completeRestart(pool, new Date(), notify);
  assert.deepEqual(seen, ['done']);

  await requestRestart(pool, null);
  const failing: CommandExecutor = async (command, cwd) =>
    command[0] === 'git' ? ok(command, cwd) : { exitCode: 1, durationMs: 1, output: 'failed to solve' };
  await processRestart(pool, '/x', () => 0, failing, undefined, { notify });
  assert.deepEqual(seen, ['done', 'failed']);
  // Ohne laufenden Neustart meldet ein Worker-Start nichts.
  await completeRestart(pool, new Date(), notify);
  assert.deepEqual(seen, ['done', 'failed']);
});

test('Neustart: baut nur einen sauberen Stand des erlaubten Branches', async () => {
  const gitState =
    (branch: string, status: string): CommandExecutor =>
    async (command, cwd) =>
      command[0] === 'git'
        ? { exitCode: 0, durationMs: 1, output: command[1] === 'rev-parse' ? `${branch}\n` : status }
        : ok(command, cwd);
  const run = async (execute: CommandExecutor, branch?: string) => {
    const pool = memoryPool();
    await requestRestart(pool, 'Patrick');
    const result = await processRestart(pool, '/x', () => 0, execute, undefined, { health: async () => true, branch });
    return { result, message: (await readRestart(pool))?.message ?? '' };
  };
  const feature = await run(gitState('fix/irgendwas', ''));
  assert.equal(feature.result, 'failed');
  assert.match(feature.message, /„fix\/irgendwas“ ausgecheckt, live gehen darf nur „main“/);
  const dirty = await run(gitState('main', ' M src/server.ts\n'));
  assert.equal(dirty.result, 'failed');
  assert.match(dirty.message, /Nicht committete Änderungen im AIdeation-Ordner \(src\/server\.ts\)/);
  assert.equal((await run(gitState('fix/irgendwas', ''), '*')).result, 'restart', '„*“ erlaubt jeden Branch');
  assert.equal((await run(gitState('release', ''), 'release')).result, 'restart');
});

test('Neustart scheitert schon vor dem Bau (falscher Branch): genau eine Benachrichtigung', async () => {
  const pool = memoryPool();
  const seen: string[] = [];
  const notify = async (_pool: unknown, state: { status: string }) => {
    seen.push(state.status);
  };
  await requestRestart(pool, 'Patrick');
  const feature: CommandExecutor = async (command, cwd) =>
    command[0] === 'git' && command[1] === 'rev-parse'
      ? { exitCode: 0, durationMs: 1, output: 'fix/irgendwas\n' }
      : ok(command, cwd);
  assert.equal(await processRestart(pool, '/x', () => 0, feature, undefined, { notify, branch: 'main' }), 'failed');
  assert.deepEqual(seen, ['failed']);
});

test('Drain: solange ein Neustart angefordert ist oder gebaut wird, startet der Worker keine neue Arbeit', async () => {
  const { acceptsNewWork } = await import('./system-restart.js');
  assert.equal(acceptsNewWork(null), true);
  assert.equal(acceptsNewWork({ status: 'requested' }), false);
  assert.equal(acceptsNewWork({ status: 'building' }), false);
  assert.equal(acceptsNewWork({ status: 'restarting' }), true);
  assert.equal(acceptsNewWork({ status: 'done' }), true);
  assert.equal(acceptsNewWork({ status: 'failed' }), true);
});
