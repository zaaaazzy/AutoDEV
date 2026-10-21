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
