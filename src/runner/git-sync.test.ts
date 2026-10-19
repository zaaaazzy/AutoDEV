import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import type { CommandExecutor } from '../core/command.js';
import {
  checkoutSprintBranch,
  mergeIntoCheckedOutMain,
  ciWorkflowYaml,
  commitTaskToGit,
  filesWithSecrets,
  isValidGitRemote,
  pushRemote,
  enterOrderBranch,
  finishOrderBranch,
  orderBranch,
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

import { taskCommitMessage, parseRunState, waitForCi } from './git-sync.js';
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

test('each order works on its own branch and is merged into the sprint branch on success', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'git-order-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['init', '-b', 'main'], { cwd });
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  await writeFile(join(cwd, 'base.txt'), 'base');
  git('add', '-A');
  git('commit', '-m', 'base');
  const item = { id: '11111111-2222-3333-4444-555555555555', title: 'Login Seite' };
  assert.equal(orderBranch(item), 'auftrag/11111111-login-seite');

  const failed = await enterOrderBranch(cwd, item, 'Sprint 1');
  assert.deepEqual(failed, { branch: 'auftrag/11111111-login-seite', base: 'sprint/sprint-1' });
  await writeFile(join(cwd, 'login.txt'), 'halb fertig');
  const wip = await finishOrderBranch(cwd, item, failed!, 'Sprint 1', false);
  assert.match(wip.message, /Zwischenstand/);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'sprint/sprint-1');
  assert.equal(git('status', '--porcelain'), '');

  const retry = await enterOrderBranch(cwd, item, 'Sprint 1');
  assert.equal(git('show', 'HEAD:login.txt'), 'halb fertig');
  await writeFile(join(cwd, 'login.txt'), 'fertig');
  const done = await finishOrderBranch(cwd, item, retry!, 'Sprint 1', true);
  assert.equal(done.merged, true);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'sprint/sprint-1');
  assert.equal(git('show', 'sprint/sprint-1:login.txt'), 'fertig');
  assert.match(git('log', '-1', '--format=%s'), /^Merge auftrag\/11111111-login-seite/);
  assert.equal(git('branch', '--list', 'auftrag/*'), '');
});

test('projects without git get no order branch', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'git-none-'));
  assert.equal(await enterOrderBranch(cwd, { id: 'x', title: 'y' }, null), null);
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

test('the CI workflow runs the same test commands as the local gate', () => {
  const yaml = ciWorkflowYaml(
    [
      ['npm', 'run', 'build'],
      ['npm', 'test', '--', '--grep', 'login page'],
    ],
    {
      node: true,
      lockfile: true,
      python: false,
    },
  );
  assert.match(yaml, /actions\/setup-node@v4/);
  assert.match(yaml, /- run: npm ci/);
  assert.match(yaml, /- run: npm run build/);
  assert.match(yaml, /- run: npm test -- --grep 'login page'/);
  assert.match(yaml, /branches: \[main, 'sprint\/\*\*'\]/);
});

test('merges a finished sprint into main checked out elsewhere only when that folder is clean', async () => {
  const run = (dirty: string, gateFails = false) => {
    const calls: string[] = [];
    const execute: CommandExecutor = async (command) => {
      calls.push(command.join(' '));
      if (command.includes('--abbrev-ref')) return { exitCode: 0, durationMs: 1, output: 'main\n' };
      if (command.includes('--porcelain')) return { exitCode: 0, durationMs: 1, output: dirty };
      if (command[0] === 'npm') return { exitCode: gateFails ? 1 : 0, durationMs: 1, output: 'rot' };
      return { exitCode: 0, durationMs: 1, output: '' };
    };
    return { calls, execute };
  };
  const clean = run('');
  assert.equal(await mergeIntoCheckedOutMain(clean.execute, '/human', 'sprint/s1', 'S1', [['npm', 'test']], []), true);
  assert.ok(clean.calls.some((call) => call.startsWith('git merge --no-ff sprint/s1')));

  const busy = run(' M src/app.ts\n');
  assert.equal(await mergeIntoCheckedOutMain(busy.execute, '/human', 'sprint/s1', 'S1', [], []), false);
  assert.ok(!busy.calls.some((call) => call.startsWith('git merge')));

  const red = run('', true);
  assert.equal(await mergeIntoCheckedOutMain(red.execute, '/human', 'sprint/s1', 'S1', [['npm', 'test']], []), false);
  assert.ok(red.calls.includes('git reset --keep ORIG_HEAD'));
});

function fakeGh(views: string[], watchExit = 1) {
  const calls: string[] = [];
  const execute = (async (command: string[]) => {
    calls.push(command.slice(0, 3).join(' '));
    const [tool, verb, sub] = command;
    const ok = (output: string, exitCode = 0) => ({ exitCode, durationMs: 0, output });
    if (tool === 'git') return ok('abc123\n');
    if (verb === 'auth') return ok('Logged in');
    if (verb === 'run' && sub === 'list') return ok('39306468551\n');
    if (verb === 'run' && sub === 'watch') return ok('Triggered via push less than a minute ago\n* verify', watchExit);
    if (verb === 'run' && sub === 'view') return ok(views.shift() ?? views.at(-1) ?? '');
    return ok('', 1);
  }) as unknown as Parameters<typeof waitForCi>[0];
  return { execute, calls };
}

test('a CI run that is still going is not reported as red', async () => {
  const log: string[] = [];
  const { execute, calls } = fakeGh([
    '{"conclusion":"","status":"in_progress"}',
    '{"conclusion":"success","status":"completed"}',
  ]);
  await waitForCi(execute, '/repo', 'sprint/sprint-5', log, 1);
  assert.deepEqual(log, ['CI grün (Lauf 39306468551).']);
  assert.equal(calls.filter((call) => call === 'gh run watch').length, 2, 'keeps watching after an early exit');
});

test('a failed CI run blocks the merge with its conclusion', async () => {
  const { execute } = fakeGh(['{"conclusion":"failure","status":"completed"}'], 1);
  await assert.rejects(waitForCi(execute, '/repo', 'sprint/sprint-5', [], 1), /ist rot \(failure\)/);
});

test('parseRunState reads the JSON of gh run view', () => {
  assert.deepEqual(parseRunState('Warnung\n{"conclusion":"","status":"queued"}\n'), {
    status: 'queued',
    conclusion: '',
  });
  assert.equal(parseRunState('kein json'), null);
});
