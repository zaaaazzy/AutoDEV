import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, open, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import { runCommand } from '../core/command.js';
import { MANUAL_TODO_PREFIX, MERGE_TODO } from './action-todo.js';
import { enterOrderBranch } from './git-sync.js';
import { type RunContext, settleItem } from './runner-steps.js';

async function project(): Promise<{ cwd: string; git: (...args: string[]) => string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'git-merge-failure-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  git('init', '-b', 'main');
  git('config', 'user.email', 'mensch@example.com');
  git('config', 'user.name', 'Mensch');
  await writeFile(join(cwd, 'base.txt'), 'base\n');
  git('add', '-A');
  git('commit', '-m', 'base');
  return { cwd, git };
}

function recordingPool(): { pool: Pool; queries: { sql: string; values: unknown[] }[] } {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  return { pool, queries };
}

const item = { id: 'cccccccc-0000-4000-8000-000000000003', projectSlug: 'p', title: 'Export', description: '' };

test('Merge scheitert ohne Konflikt (Sperre gehalten): blockiert mit Vermerk statt still, Ordner ohne Reste', async (t) => {
  if (process.platform === 'win32') return t.skip('ohne lsof gilt die Sperre erst nach 10 Minuten als verwaist');
  const { cwd, git } = await project();
  const branch = await enterOrderBranch(cwd, item, null);
  assert.ok(branch);
  // Arbeit des Agents (noch nicht committet) und ein neuer Commit auf main: Der Merge braucht wirklich ort.
  await writeFile(join(cwd, 'export.ts'), 'export const csv = 1;\n');
  git('update-ref', 'refs/heads/main', git('commit-tree', 'main^{tree}', '-p', 'main', '-m', 'main weiter'));
  const lock = join(git('rev-parse', '--absolute-git-dir'), 'AUTO_MERGE.lock');
  await writeFile(lock, '');
  const old = new Date(Date.now() - 5 * 60_000);
  await utimes(lock, old, old);
  const handle = await open(lock, 'r');
  const { pool, queries } = recordingPool();
  try {
    const ctx = { pool, item, options: { cwd, timeoutMs: 1 }, execute: runCommand, branch } as unknown as RunContext;
    await settleItem(ctx, true, false);
  } finally {
    await handle.close();
  }
  const todo = queries.find((query) => query.sql.includes('SET action_todo = $2'));
  assert.equal(todo?.values[1], MERGE_TODO);
  const settled = queries.find((query) => query.sql.includes('return_status = NULL'));
  assert.equal(settled?.values[1], 'blocked');
  assert.equal(git('status', '--porcelain'), '', 'export.ts aus dem halben Merge liegt nicht unversioniert herum');
  assert.ok(git('show', '--name-only', '--format=', branch.branch).includes('export.ts'), 'Arbeit auf dem Branch');
});

test('Einzellauf eines Agents: main bleibt unverändert, Arbeit liegt committet auf dem Auftrags-Branch', async () => {
  const { cwd, git } = await project();
  const single = { ...item, id: 'cccccccc-0000-4000-8000-000000000004', agentId: 'entwickler-id' };
  const before = git('rev-parse', 'main');
  const branch = await enterOrderBranch(cwd, single, null);
  assert.ok(branch);
  await writeFile(join(cwd, 'export.ts'), 'export const csv = 1;\n');
  const { pool, queries } = recordingPool();
  const ctx = {
    pool,
    item: single,
    options: { cwd, timeoutMs: 1 },
    execute: runCommand,
    branch,
  } as unknown as RunContext;
  await settleItem(ctx, true, false);

  assert.equal(git('rev-parse', 'main'), before, 'main unverändert');
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'Arbeitsordner zurück auf der Basis');
  assert.equal(git('status', '--porcelain'), '');
  assert.ok(git('show', '--name-only', '--format=', branch.branch).includes('export.ts'), 'Arbeit auf dem Branch');
  // Kein Merge-Problem, kein Commit-Verweis auf main, Auftrag eindeutig zurück auf „Geplant“ (nicht blockiert).
  assert.ok(!queries.some((query) => query.sql.includes('SET failure')));
  assert.ok(!queries.some((query) => query.sql.includes('git_commit')));
  const settled = queries.find((query) => query.sql.includes('return_status = NULL'));
  assert.equal(settled?.values[1], true);

  // Der normale Ablauf setzt den Branch samt Commit fort und mergt erst dann.
  const again = await enterOrderBranch(cwd, single, null);
  assert.equal(again?.branch, branch.branch);
  assert.ok(git('ls-files').includes('export.ts'));
});

test('Gescheiterter Auftrag: alter Abnahmehinweis „Selbst prüfen: …“ wird gelöscht', async () => {
  const { pool, queries } = recordingPool();
  const ctx = { pool, item, options: { cwd: '/tmp', timeoutMs: 1 }, execute: runCommand } as unknown as RunContext;
  await settleItem(ctx, false, false);
  const cleared = queries.find((query) => query.sql.includes('SET action_todo = NULL'));
  assert.ok(cleared, 'Abnahmehinweis wird gelöscht');
  assert.equal(cleared.values[1], MANUAL_TODO_PREFIX);
});
