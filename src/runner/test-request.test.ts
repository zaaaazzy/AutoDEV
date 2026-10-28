import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Pool } from 'pg';
import type { CommandExecutor } from '../core/command.js';
import { fullTestExtraEnv, processTestRequest } from './test-request.js';

test('Testanfrage: run_id ist vor den Befehlen gesetzt, bei Fehler wird der Lauf beendet', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'test-request-'));
  const queries: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes("SET status = 'running'")) return { rows: [{ id: 'req-1', scope: 'full' }] };
      if (sql.includes('test_commands')) return { rows: [{ commands: [['npm', 'test']] }] };
      return { rows: [] };
    },
  } as unknown as Pool;
  const execute: CommandExecutor = async () => ({ exitCode: 1, durationMs: 0, output: '' });
  let linkedBeforeRun = false;
  try {
    const handled = await processTestRequest(pool, { project: 'demo', cwd }, execute, async (options) => {
      await options.onRunCreated?.('run-7');
      linkedBeforeRun = queries.some((q) => q.sql.includes('SET run_id') && q.params[1] === 'run-7');
      throw new Error('Worker abgestürzt');
    });
    assert.equal(handled, true);
    assert.equal(linkedBeforeRun, true);
    assert.ok(queries.some((q) => q.sql.includes('UPDATE test_runs') && q.params[0] === 'req-1'));
    assert.ok(queries.some((q) => q.sql.includes("status = 'failed'") && q.params[1] === 'Worker abgestürzt'));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Komplettlauf: Umgebung enthält DB-Zugang und Admin-Ziel, aber keine anderen DEV_LOG_*-Geheimnisse', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'test-request-full-'));
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { 'test:full': 'tsx scripts/test-full.ts' } }));
  // Passwort ungleich devlog_local_dev, mit Sonderzeichen (URL-kodiert), wie vom Einrichtungs-Assistenten erzeugt.
  const databaseUrl = 'postgresql://devlog:geheim%40%3A%2F42@127.0.0.1:5433/aideation';
  const saved = { ...process.env };
  Object.assign(process.env, {
    DEV_LOG_DATABASE_URL: databaseUrl,
    DEV_LOG_SECRET_KEY: 'secret-key-value',
    DEV_LOG_PASSWORD: 'admin-passwort',
    DEV_LOG_DB_PASSWORD: 'db-passwort',
  });
  delete process.env.DEV_LOG_ADMIN_DATABASE_URL;
  delete process.env.E2E_ADMIN_DATABASE_URL;
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("SET status = 'running'")) return { rows: [{ id: 'req-2', scope: 'full' }] };
      if (sql.includes('SELECT run_id')) return { rows: [{ runId: 'run-9' }] };
      return { rows: [] };
    },
  } as unknown as Pool;
  let fullEnv: NodeJS.ProcessEnv | undefined;
  const execute: CommandExecutor = async (command, _cwd, options) => {
    if (command.includes('test:full')) fullEnv = options?.env;
    return { exitCode: command[0] === 'git' ? 1 : 0, durationMs: 0, output: '' };
  };
  try {
    assert.equal(await processTestRequest(pool, { project: 'demo', cwd }, execute), true);
    assert.ok(fullEnv, 'test:full wurde nicht gestartet');
    assert.equal(fullEnv.DEV_LOG_DATABASE_URL, databaseUrl);
    assert.equal(fullEnv.E2E_ADMIN_DATABASE_URL, 'postgresql://devlog:geheim%40%3A%2F42@127.0.0.1:5433/postgres');
    const devLog = Object.keys(fullEnv).filter((key) => key.startsWith('DEV_LOG_'));
    assert.deepEqual(devLog, ['DEV_LOG_DATABASE_URL']);
    assert.equal(fullEnv.DEV_LOG_SECRET_KEY, undefined);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Komplettlauf: offene Änderungen im Agent-Worktree → kein Testbefehl, keine Bugs, Anforderung failed mit Grund', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'test-request-dirty-'));
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { 'test:full': 'tsx scripts/test-full.ts' } }));
  const queries: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes("SET status = 'running'")) return { rows: [{ id: 'req-3', scope: 'full' }] };
      return { rows: [] };
    },
  } as unknown as Pool;
  // Verknüpfter Worktree je Fall: sauber, schmutzig, git status scheitert, Hauptordner, schon losgelöst.
  const run = async (
    status: { exitCode: number; output: string },
    dirs = '/repo/.git/worktrees/agent\n/repo/.git\n',
  ) => {
    const calls: string[] = [];
    let agentStarted = false;
    queries.length = 0;
    const execute: CommandExecutor = async (command) => {
      calls.push(command.join(' '));
      if (command.includes('--git-common-dir')) return { exitCode: 0, durationMs: 0, output: dirs };
      if (command.includes('--porcelain')) return { ...status, durationMs: 0 };
      if (command.includes('symbolic-ref')) {
        const detached = dirs.includes('detached');
        return { exitCode: detached ? 1 : 0, durationMs: 0, output: detached ? '' : 'auftrag/x\n' };
      }
      return { exitCode: 0, durationMs: 0, output: '' };
    };
    await processTestRequest(pool, { project: 'demo', cwd }, execute, async () => {
      agentStarted = true;
      return 'run-1';
    });
    const failed = queries.find((q) => q.sql.includes("UPDATE test_requests SET status = 'failed'"));
    return { ran: calls.some((call) => call.includes('test:full')), calls, agentStarted, failed };
  };
  try {
    const dirty = await run({ exitCode: 0, output: ' M src/halbfertig.ts\n' });
    assert.equal(dirty.ran, false, 'Komplettlauf darf auf halbfertigem Stand nicht starten');
    assert.equal(dirty.agentStarted, false);
    assert.ok(!dirty.calls.some((call) => call.startsWith('git checkout -q --detach')));
    assert.ok(!queries.some((q) => q.sql.includes('INSERT INTO bugs') || q.sql.includes('bug_count')));
    assert.match(String(dirty.failed?.params[1]), /Offene Änderungen im Agent-Worktree/);
    assert.ok(dirty.calls.some((call) => call.includes('--untracked-files=no')));

    const broken = await run({ exitCode: 128, output: 'fatal: index kaputt' });
    assert.equal(broken.ran, false);
    assert.match(String(broken.failed?.params[1]), /git status/);

    // Gegenproben: sauber, Hauptordner und schon losgelöst testen weiter.
    for (const [label, result] of [
      ['sauber', await run({ exitCode: 0, output: '' })],
      ['Hauptordner', await run({ exitCode: 0, output: ' M x.ts\n' }, '/repo/.git\n/repo/.git\n')],
      ['losgelöst', await run({ exitCode: 0, output: '' }, '/repo/.git/worktrees/detached\n/repo/.git\n')],
    ] as const) {
      assert.equal(result.ran, true, `${label}: Komplettlauf muss starten`);
      assert.equal(result.failed, undefined, `${label}: Anforderung darf nicht scheitern`);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Komplettlauf: ohne DB-Zugang im Worker keine zusätzlichen Variablen, vorgegebenes Admin-Ziel gilt', () => {
  assert.deepEqual(fullTestExtraEnv({ DEV_LOG_SECRET_KEY: 'x' }), {});
  assert.deepEqual(
    fullTestExtraEnv({
      DEV_LOG_DATABASE_URL: 'postgresql://u:p@db:5432/aideation',
      DEV_LOG_ADMIN_DATABASE_URL: 'postgresql://u:p@db:5432/verwaltung',
    }),
    {
      DEV_LOG_DATABASE_URL: 'postgresql://u:p@db:5432/aideation',
      E2E_ADMIN_DATABASE_URL: 'postgresql://u:p@db:5432/verwaltung',
    },
  );
});
