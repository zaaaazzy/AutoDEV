import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { acquireTree } from '../core/project-lock.js';
import { processApprovals } from './review-gate.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();

/** Projektordner der Menschen auf main, Agents in eigenem, losgelöstem Worktree; Auftrags-Branch ohne Sprint auf main. */
function repository(branch: string): { folder: string; agents: string } {
  const root = mkdtempSync(join(tmpdir(), 'review-wt-'));
  const folder = join(root, 'App');
  mkdirSync(folder);
  writeFileSync(join(folder, 'a.txt'), 'start\n');
  git(folder, 'init', '-q', '-b', 'main');
  git(folder, 'config', 'user.email', 't@t');
  git(folder, 'config', 'user.name', 't');
  git(folder, 'add', '-A');
  git(folder, 'commit', '-q', '-m', 'init');
  const agents = join(root, 'App-agents');
  git(folder, 'worktree', 'add', '-q', '-b', branch, agents, 'main');
  writeFileSync(join(agents, 'fix.ts'), 'export {};\n');
  git(agents, 'add', '-A');
  git(agents, 'commit', '-q', '-m', 'Fix');
  git(agents, 'checkout', '-q', '--detach', 'main');
  return { folder, agents };
}

function fakePool(folder: string, item: Record<string, unknown>): { pool: Pool; done: () => string | null } {
  let done: string | null = null;
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('review_approved_at IS NOT NULL')) return { rows: [item], rowCount: 1 };
      if (sql.includes('agent_workspace AS separate')) return { rows: [{ repository: folder, separate: true }] };
      if (sql.includes("status = 'done'")) done = sql;
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, done: () => done };
}

test('Freigabe ohne Sprint: main im Ordner der Menschen ausgecheckt, Merge dort und erst nach der Ordnersperre', async () => {
  const branch = 'auftrag/f5291510-ohne-sprint';
  const { folder, agents } = repository(branch);
  const item = { id: 'f5291510', projectSlug: 'app', title: 'Bugfix', bugId: null, branch, base: 'main' };
  const { pool, done } = fakePool(folder, item);
  const fixCommit = git(folder, 'rev-parse', branch);

  // Ein schreibender Chat hält den Agent-Ordner: Die Freigabe wartet, statt dazwischen zu mergen.
  const releaseChat = await acquireTree(agents);
  let finished = false;
  const running = processApprovals(pool, 'app', agents).then((count) => {
    finished = true;
    return count;
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(finished, false, 'wartet auf die Ordnersperre');
  assert.equal(git(folder, 'rev-list', '--count', 'main'), '1');
  releaseChat();

  assert.equal(await running, 1);
  assert.ok(done(), 'Auftrag erledigt statt „Freigabe nicht gemergt“');
  // Erfolg setzt die Konflikt-Neuversuche zurück, im selben UPDATE (Code-Review vom 21.10.2026).
  assert.match(done()!, /conflict_retries = 0/);
  assert.equal(git(folder, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(readFileSync(join(folder, 'fix.ts'), 'utf8'), 'export {};\n');
  git(folder, 'merge-base', '--is-ancestor', fixCommit, 'main');
  assert.equal(git(folder, 'branch', '--list', branch), '');
});

test('Freigabe: Vorschau im Projektordner zieht auf die Basis nach', async () => {
  const branch = 'auftrag/f5291511-vorschau';
  const { folder, agents } = repository(branch);
  git(folder, 'branch', 'sprint/s1', 'main');
  git(folder, 'checkout', '-q', '--detach', 'main');
  git(agents, 'checkout', '-q', '--detach', 'sprint/s1');
  const item = { id: 'f5291511', projectSlug: 'app', title: 'Liste', bugId: null, branch, base: 'sprint/s1' };
  const { pool } = fakePool(folder, item);

  assert.equal(await processApprovals(pool, 'app', agents), 1);
  assert.equal(git(folder, 'rev-parse', 'HEAD'), git(folder, 'rev-parse', 'sprint/s1'));
  assert.equal(readFileSync(join(folder, 'fix.ts'), 'utf8'), 'export {};\n');
});
