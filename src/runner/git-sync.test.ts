import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import { isValidGitRemote, pushRemote, sprintTag, syncSprintToGit } from './git-sync.js';

function fakePool(
  remote: string | null,
  action: 'push' | 'pull' = 'push',
): { pool: Pool; updates: { sql: string; values: unknown[] }[] } {
  const updates: { sql: string; values: unknown[] }[] = [];
  let claimed = false;
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      updates.push({ sql, values });
      if (sql.includes("SET git_sync = 'running'") && !claimed) {
        claimed = true;
        return { rows: [{ id: 'abcdef12-0000-0000-0000-000000000000', name: 'Sprint 1: Äpfel', action, remote }] };
      }
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, updates };
}

test('remote URLs must not carry credentials', () => {
  assert.ok(isValidGitRemote('https://github.com/zaaaazzy/Mainty.git'));
  assert.ok(isValidGitRemote('git@github.com:zaaaazzy/Mainty.git'));
  assert.ok(!isValidGitRemote('https://user:token@github.com/x/y.git'));
  assert.ok(!isValidGitRemote('file:///etc'));
  assert.ok(!isValidGitRemote('--upload-pack=evil'));
  assert.equal(sprintTag('Sprint 1: Äpfel!', 'abcdef12'), 'sprint-sprint-1-apfel-abcdef');
});

test('a completed sprint is committed with its name and tagged locally', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'git-sync-'));
  await writeFile(join(cwd, 'a.txt'), 'hallo');
  await writeFile(join(cwd, '.gitignore'), '.env\n');
  await writeFile(join(cwd, '.env'), 'SECRET=1');
  const { pool, updates } = fakePool(null);
  assert.equal(await syncSprintToGit(pool, 'p', cwd), 1);
  assert.equal(execFileSync('git', ['log', '-1', '--format=%s'], { cwd }).toString().trim(), 'Sprint: Sprint 1: Äpfel');
  assert.match(execFileSync('git', ['tag'], { cwd }).toString(), /sprint-sprint-1-apfel-abcdef/);
  assert.ok(!execFileSync('git', ['ls-files'], { cwd }).toString().includes('.env\n'));
  const final = updates.at(-1);
  assert.match(final?.sql ?? '', /git_sync = 'done'/);
  assert.match(String(final?.values[1]), /nur lokal gesichert/);
});

test('push failures are recorded instead of thrown', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'git-sync-'));
  await writeFile(join(cwd, 'a.txt'), 'x');
  const { pool, updates } = fakePool(`file://${cwd}/nope`.replace('file://', 'https://invalid.invalid'));
  assert.equal(
    await syncSprintToGit(pool, 'p', cwd, async (command, dir, options) => {
      const { runCommand } = await import('../core/command.js');
      return command[1] === 'push'
        ? { exitCode: 1, durationMs: 1, output: 'auth failed' }
        : runCommand(command, dir, options);
    }),
    0,
  );
  assert.match(updates.at(-1)?.sql ?? '', /git_sync = 'failed'/);
  assert.match(String(updates.at(-1)?.values[1]), /auth failed/);
});

test('a pull request fast-forwards the project to the remote state', async () => {
  const base = await mkdtemp(join(tmpdir(), 'git-pull-'));
  const remote = join(base, 'remote.git');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
  const other = join(base, 'other');
  execFileSync('git', ['clone', remote, other], { stdio: 'pipe' });
  git(other, 'config', 'user.email', 'a@b.c');
  git(other, 'config', 'user.name', 'a');
  await writeFile(join(other, 'one.txt'), '1');
  git(other, 'add', '-A');
  git(other, 'commit', '-m', 'one');
  git(other, 'branch', '-M', 'main');
  git(other, 'push', '-u', 'origin', 'main');
  const local = join(base, 'local');
  execFileSync('git', ['clone', remote, local], { stdio: 'pipe' });
  await writeFile(join(other, 'two.txt'), '2');
  git(other, 'add', '-A');
  git(other, 'commit', '-m', 'two');
  git(other, 'push');
  const { pool, updates } = fakePool(remote, 'pull');
  assert.equal(await syncSprintToGit(pool, 'p', local), 1);
  assert.equal(git(local, 'log', '-1', '--format=%s'), 'two');
  assert.match(String(updates.at(-1)?.values[1]), /Stand von GitHub geladen/);
});

test('pushes GitHub HTTPS remotes over SSH', () => {
  assert.equal(pushRemote('https://github.com/zaaaazzy/testobject'), 'git@github.com:zaaaazzy/testobject.git');
  assert.equal(pushRemote('https://github.com/a/b.git'), 'git@github.com:a/b.git');
  assert.equal(pushRemote('git@github.com:a/b.git'), 'git@github.com:a/b.git');
});

import { taskCommitMessage } from './git-sync.js';
import test2 from 'node:test';
import assert2 from 'node:assert/strict';

test2('taskCommitMessage nutzt Conventional Commits', () => {
  const [subject, body] = taskCommitMessage('bug', 'Sprint (1): Init', 'Login   kaputt\nsofort', 'abc');
  assert2.equal(subject, 'fix(Sprint 1 Init): Login kaputt sofort');
  assert2.match(body, /Auftrag: abc/);
  assert2.equal(taskCommitMessage('feature', '', 'X', 'i')[0], 'feat(sprint): X');
});
