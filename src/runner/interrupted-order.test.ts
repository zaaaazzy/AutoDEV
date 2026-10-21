import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import { runCommand } from '../core/command.js';
import { enterOrderBranch } from './git-sync.js';
import { type RunContext, settleItem } from './runner-steps.js';

/** Projekt mit main und einem Commit. */
async function project(): Promise<{ cwd: string; git: (...args: string[]) => string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'git-interrupted-'));
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

const first = { id: 'aaaaaaaa-0000-4000-8000-000000000001', projectSlug: 'p', title: 'Login-Seite', description: '' };
const second = { id: 'bbbbbbbb-0000-4000-8000-000000000002', projectSlug: 'p', title: 'Statistik', description: '' };

test('Unterbrochener Auftrag (Nutzungslimit, Neustart, Pause): WIP gesichert, Ordner sauber auf der Basis', async () => {
  const { cwd, git } = await project();
  const branch = await enterOrderBranch(cwd, first, null);
  assert.ok(branch);
  // Der Entwickler war mitten in der Arbeit: geänderte und neue Dateien, nichts committet.
  await writeFile(join(cwd, 'base.txt'), 'base\nhalb fertig\n');
  await writeFile(join(cwd, 'login.ts'), 'export const login = 1;\n');
  const { pool, queries } = recordingPool();
  const ctx = {
    pool,
    item: first,
    options: { cwd, timeoutMs: 1 },
    execute: runCommand,
    branch,
  } as unknown as RunContext;

  await settleItem(ctx, false, true);

  // Der Ordner steht wieder auf main und ist sauber – der nächste Auftrag kann starten.
  assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(git('status', '--porcelain'), '');
  // Die Arbeit liegt als Commit auf dem Auftrags-Branch.
  assert.deepEqual(git('show', '--name-only', '--format=', branch.branch).split('\n').sort(), ['base.txt', 'login.ts']);
  // Der Auftrag bleibt eingeplant (kein „blockiert“).
  const settled = queries.find((query) => query.sql.includes('UPDATE development_items'));
  assert.match(settled?.sql ?? '', /status = 'planned'/);

  // Ein anderer Auftrag bekommt jetzt seinen eigenen Branch statt eines OrderBranchError.
  const next = await enterOrderBranch(cwd, second, null);
  assert.ok(next);
  assert.notEqual(next.branch, branch.branch);
  await settleItem({ ...ctx, item: second, branch: next }, false, true);

  // Der unterbrochene Auftrag setzt später seinen Branch samt Zwischenstand fort.
  const resumed = await enterOrderBranch(cwd, first, null);
  assert.equal(resumed?.branch, branch.branch);
  assert.equal(await readFile(join(cwd, 'login.ts'), 'utf8'), 'export const login = 1;\n');
});
