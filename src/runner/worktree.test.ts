import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { closeWorktree, openWorktree } from './git-sync.js';

const ITEM = { id: 'abcdef12-0000-0000-0000-000000000000', title: 'Gruß ändern' };

async function repository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'worktree-repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  await writeFile(join(cwd, 'a.txt'), 'hallo\n');
  await mkdir(join(cwd, 'node_modules'));
  await writeFile(join(cwd, '.gitignore'), 'node_modules/\n');
  git('add', '-A');
  git('commit', '-m', 'start');
  return cwd;
}

async function useWorktreeRoot(t: test.TestContext): Promise<void> {
  const previous = process.env.DEV_LOG_WORKTREE_ROOT;
  process.env.DEV_LOG_WORKTREE_ROOT = await mkdtemp(join(tmpdir(), 'worktrees-'));
  t.after(() => {
    if (previous === undefined) delete process.env.DEV_LOG_WORKTREE_ROOT;
    else process.env.DEV_LOG_WORKTREE_ROOT = previous;
  });
}

const log = (cwd: string): string => execFileSync('git', ['log', '--format=%s'], { cwd }).toString();

test('an isolated order works on its own branch and is merged only when closed', async (t) => {
  await useWorktreeRoot(t);
  const cwd = await repository();
  const worktree = await openWorktree(cwd, 'demo', ITEM.id);
  assert.equal(worktree.branch, 'devlog/abcdef12');
  assert.ok(existsSync(join(worktree.path, 'node_modules')), 'node_modules is linked in');
  await writeFile(join(worktree.path, 'a.txt'), 'servus\n');
  assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'hallo\n', 'project folder stays untouched');

  // A retry reopens the same worktree with its changes.
  assert.deepEqual(await openWorktree(cwd, 'demo', ITEM.id), worktree);
  assert.equal(await readFile(join(worktree.path, 'a.txt'), 'utf8'), 'servus\n');

  const result = await closeWorktree(worktree, ITEM, 'Sprint 1');
  assert.ok(result.merged, result.message);
  assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'servus\n');
  assert.match(log(cwd), /^feat\(Sprint 1\): Gruß ändern/);
  assert.ok(!existsSync(worktree.path), 'worktree is removed');
  assert.doesNotMatch(execFileSync('git', ['branch'], { cwd }).toString(), /devlog\//);
});

test('a conflicting merge is aborted and keeps the branch', async (t) => {
  await useWorktreeRoot(t);
  const cwd = await repository();
  const worktree = await openWorktree(cwd, 'demo', ITEM.id);
  await writeFile(join(worktree.path, 'a.txt'), 'servus\n');
  await writeFile(join(cwd, 'a.txt'), 'moin\n');
  execFileSync('git', ['commit', '-am', 'parallel'], { cwd });

  const result = await closeWorktree(worktree, ITEM, null);
  assert.equal(result.merged, false);
  assert.match(result.message, /devlog\/abcdef12/);
  assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'moin\n');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd }).toString(), '');
  assert.match(execFileSync('git', ['branch'], { cwd }).toString(), /devlog\/abcdef12/);
});

test('a repository without a commit cannot run isolated', async (t) => {
  await useWorktreeRoot(t);
  const cwd = await mkdtemp(join(tmpdir(), 'worktree-empty-'));
  await assert.rejects(openWorktree(cwd, 'demo', ITEM.id), /noch keinen Commit/);
});
