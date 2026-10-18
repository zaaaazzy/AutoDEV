import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  checkoutSprintBranch,
  commitTaskToGit,
  filesWithSecrets,
  isValidGitRemote,
  pushRemote,
  restoreShelvedWork,
  shelveFailedWork,
  sprintBranch,
  sprintTag,
  syncSprintToGit,
} from './git-sync.js';

function fakePool(
  remote: string | null,
  action: 'push' | 'pull' = 'push',
  testCommands: string[][] = [['true']],
  status = 'active',
): { pool: Pool; updates: { sql: string; values: unknown[] }[] } {
  const updates: { sql: string; values: unknown[] }[] = [];
  let claimed = false;
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      updates.push({ sql, values });
      if (sql.includes("SET git_sync = 'running'") && !claimed) {
        claimed = true;
        return {
          rows: [{ id: 'abcdef12-0000-0000-0000-000000000000', name: 'Sprint 1: Äpfel', action, remote, status }],
        };
      }
      if (sql.includes('test_commands')) return { rows: [{ commands: testCommands }] };
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
  assert.equal(
    execFileSync('git', ['log', '-1', '--format=%s'], { cwd }).toString().trim(),
    'chore(Sprint 1: Äpfel): Sprint-Stand sichern',
  );
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

test('red tests block the push and keep the sprint unsynced', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'git-gate-'));
  await writeFile(join(cwd, 'a.txt'), 'x');
  const pushed: string[][] = [];
  const { pool, updates } = fakePool('https://github.com/a/b.git', 'push', [['false']]);
  const result = await syncSprintToGit(pool, 'p', cwd, async (command, dir, options) => {
    const { runCommand } = await import('../core/command.js');
    if (command[1] === 'push') pushed.push(command);
    return command[1] === 'push' ? { exitCode: 0, durationMs: 1, output: '' } : runCommand(command, dir, options);
  });
  assert.equal(result, 0);
  assert.deepEqual(pushed, []);
  assert.match(String(updates.at(-1)?.values[1]), /Push abgelehnt: `false`/);
});

test('orders work on the sprint branch and a completed sprint is merged into main', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'git-branch-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['init', '-b', 'main'], { cwd });
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  await writeFile(join(cwd, 'base.txt'), 'base');
  git('add', '-A');
  git('commit', '-m', 'base');
  assert.equal(sprintBranch('Sprint 1: Äpfel'), 'sprint/sprint-1-apfel');
  assert.equal(await checkoutSprintBranch(cwd, 'Sprint 1: Äpfel'), 'sprint/sprint-1-apfel');
  await writeFile(join(cwd, 'feature.txt'), 'neu');
  git('add', '-A');
  git('commit', '-m', 'feat: Auftrag');
  const { pool } = fakePool(null, 'push', [['true']], 'completed');
  assert.equal(await syncSprintToGit(pool, 'p', cwd), 1);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.match(git('log', '-1', '--format=%s'), /^Merge sprint\/sprint-1-apfel/);
  assert.equal(git('show', 'main:feature.txt'), 'neu');
});

test('work of a failed order is parked and restored on the next attempt', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'git-shelve-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['init', '-b', 'main'], { cwd });
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  await writeFile(join(cwd, 'base.txt'), 'base');
  git('add', '-A');
  git('commit', '-m', 'base');
  await writeFile(join(cwd, 'mine.txt'), 'fehlgeschlagen');
  await writeFile(join(cwd, 'other.txt'), 'anderer Auftrag');
  const item = { id: '11111111-2222-3333-4444-555555555555', title: 'Kaputt' };
  assert.equal(await shelveFailedWork(cwd, item, ['mine.txt']), true);
  assert.equal(git('status', '--porcelain'), '?? other.txt');
  assert.equal(await shelveFailedWork(cwd, item, []), false);
  assert.equal(await restoreShelvedWork(cwd, item.id), true);
  assert.match(git('status', '--porcelain'), /mine\.txt/);
});

test('files that look like credentials are never committed', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'git-secrets-'));
  await writeFile(join(cwd, 'a.txt'), 'hallo');
  await writeFile(join(cwd, 'config.ts'), `export const token = 'ghp_${'a'.repeat(36)}';\n`);
  await writeFile(join(cwd, 'deploy.pem'), '-----BEGIN RSA PRIVATE KEY-----\nabc\n');
  const commit = await commitTaskToGit(cwd, { id: 'i1', title: 'Test' }, 'Sprint 1');
  assert.ok(commit);
  const files = execFileSync('git', ['ls-files'], { cwd }).toString().trim().split('\n');
  assert.deepEqual(files, ['a.txt']);
  const untracked = execFileSync('git', ['status', '--porcelain'], { cwd }).toString();
  assert.match(untracked, /config\.ts/);
});

test('secret detection looks only at added lines', () => {
  const diff = [
    '+++ b/src/a.ts',
    '+const key = "AKIAABCDEFGHIJKLMNOP";',
    '+++ b/src/b.ts',
    '-const old = "AKIAABCDEFGHIJKLMNOP";',
    '+const ok = 1;',
  ].join('\n');
  assert.deepEqual(filesWithSecrets(diff), ['src/a.ts']);
});
