import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import type { CommandExecutor } from '../core/command.js';
import type { HosterAdapter } from './hoster.js';
import {
  ciLogExcerpt,
  maskSecrets,
  pollSprintReviews,
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

/** Projekt mit main (gepusht auf ein lokales Bare-Repository als „GitHub“) und einem Sprint-Branch mit einem Auftrag. */
async function sprintRepository(): Promise<{ cwd: string; remote: string; git: (...args: string[]) => string }> {
  const base = await mkdtemp(join(tmpdir(), 'git-pr-'));
  const remote = join(base, 'remote.git');
  const cwd = join(base, 'project');
  execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-b', 'main', cwd]);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  await writeFile(join(cwd, 'base.txt'), 'base');
  git('add', '-A');
  git('commit', '-m', 'base');
  git('remote', 'add', 'origin', remote);
  git('push', '-u', 'origin', 'main');
  git('checkout', '-b', 'sprint/sprint-1-apfel');
  await writeFile(join(cwd, 'feature.txt'), 'neu');
  git('add', '-A');
  git('commit', '-m', 'feat: Auftrag');
  return { cwd, remote, git };
}

function prPool(mode: string, report = '# Sprint-Dokumentation: Sprint 1') {
  const { pool, updates } = fakePool('https://github.com/a/b.git', 'push', [['true']], 'completed');
  const query = pool.query.bind(pool) as (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
  (pool as unknown as { query: typeof query }).query = async (sql, values = []) => {
    if (sql.includes('github_mode AS mode')) {
      updates.push({ sql, values });
      return { rows: [{ mode }] };
    }
    if (sql.includes("kind = 'sprint'")) {
      updates.push({ sql, values });
      return { rows: [{ content: report }] };
    }
    return query(sql, values);
  };
  return { pool, updates };
}

/** Echte Git-Befehle, aber Push ins Bare-Repository statt nach GitHub und gh als Mock. */
function prExecutor(gh: (command: string[]) => { exitCode?: number; output?: string }, remote: string) {
  const calls: string[][] = [];
  const execute: CommandExecutor = async (command, dir, options) => {
    calls.push(command);
    if (command[0] === 'gh') return { exitCode: 0, durationMs: 1, output: '', ...gh(command) };
    const { runCommand } = await import('../core/command.js');
    if (command[0] === 'git' && command[1] === 'remote' && command[2] === 'set-url')
      return runCommand(['git', 'remote', 'set-url', 'origin', remote], dir, options);
    return runCommand(command, dir, options);
  };
  return { calls, execute };
}

test('PR mode: sprint completion opens a pull request with the sprint report and does not merge', async () => {
  const { cwd, remote, git } = await sprintRepository();
  const { pool, updates } = prPool('issues+pr', '# Sprint-Dokumentation: Sprint 1\n\n- Feature `x`');
  let body = '';
  const { calls, execute } = prExecutor((command) => {
    if (command[2] === 'list') return { output: '[]' };
    if (command[2] === 'create') {
      body = readFileSync(command[command.indexOf('--body-file') + 1]!, 'utf8');
      return { output: 'https://github.com/a/b/pull/42\n' };
    }
    return {};
  }, remote);
  assert.equal(await syncSprintToGit(pool, 'p', cwd, execute), 1);
  const create = calls.find((call) => call[0] === 'gh' && call[2] === 'create')!;
  assert.equal(create[create.indexOf('--title') + 1], 'Sprint: Sprint 1: Äpfel');
  assert.equal(create[create.indexOf('--head') + 1], 'sprint/sprint-1-apfel');
  assert.match(body, /^# Sprint-Dokumentation: Sprint 1\n\n- Feature `x`/);
  assert.ok(!calls.some((call) => call[0] === 'gh' && call[1] === 'run'), 'kein Warten auf CI im Abschluss');
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'sprint/sprint-1-apfel');
  assert.throws(() => git('show', 'main:feature.txt'));
  assert.equal(git('tag'), '');
  const final = updates.at(-1)!;
  assert.match(final.sql, /SET status = 'review', pr_url = \$5, ci_status = 'pending'/);
  assert.equal(final.values[4], 'https://github.com/a/b/pull/42');
});

test('PR mode without gh login completes the sprint like today (direct merge and tag)', async () => {
  const { cwd, remote, git } = await sprintRepository();
  const { pool, updates } = prPool('issues+pr');
  const { calls, execute } = prExecutor(() => ({ exitCode: 1, output: 'not logged in' }), remote);
  assert.equal(await syncSprintToGit(pool, 'p', cwd, execute), 1);
  assert.ok(!calls.some((call) => call[0] === 'gh' && call[1] === 'pr'));
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git('show', 'main:feature.txt'), 'neu');
  assert.match(git('tag'), /sprint-sprint-1-apfel-abcdef/);
  assert.match(String(updates.at(-1)?.values[1]), /PR-Modus übersprungen/);
});

test('mode "issues" keeps the direct merge path', async () => {
  const { cwd, remote, git } = await sprintRepository();
  const { pool } = prPool('issues');
  const { calls, execute } = prExecutor(() => ({ exitCode: 1, output: 'not logged in' }), remote);
  assert.equal(await syncSprintToGit(pool, 'p', cwd, execute), 1);
  assert.ok(!calls.some((call) => call[0] === 'gh' && call[1] === 'pr'));
  assert.equal(git('show', 'main:feature.txt'), 'neu');
});

interface ReviewRow {
  id: string;
  name: string;
  prUrl: string;
  ciStatus: string | null;
  ciBugRun: string | null;
  status: string;
}

function reviewPool(sprint: ReviewRow) {
  const updates: { sql: string; values: unknown[] }[] = [];
  const bugs: { title: string; description: string; source: string }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      updates.push({ sql, values });
      if (sql.includes("status = 'review' AND pr_url IS NOT NULL"))
        return { rows: sprint.status === 'review' ? [{ ...sprint }] : [] };
      if (sql.includes('SET ci_bug_run')) {
        if (sprint.ciBugRun === values[1]) return { rows: [] };
        sprint.ciBugRun = String(values[1]);
        return { rows: [{ id: sprint.id }] };
      }
      if (sql.includes('INSERT INTO bugs')) {
        assert.match(sql, /'github'/);
        bugs.push({ title: String(values[1]), description: String(values[2]), source: 'github' });
      }
      if (sql.includes('SET ci_status = $2 WHERE')) sprint.ciStatus = String(values[1]);
      if (sql.includes("SET status = 'completed'")) sprint.status = 'completed';
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, updates, bugs };
}

function reviewAdapter(state: {
  checks: 'pending' | 'success' | 'failure';
  approved?: boolean;
  pr?: 'open' | 'merged' | 'closed';
  log?: string;
}) {
  const merged: string[] = [];
  const adapter: HosterAdapter = {
    authStatus: async () => ({ ok: true, message: 'ok' }),
    listIssues: async () => [],
    commentIssue: async () => undefined,
    closeIssue: async () => undefined,
    findPullRequest: async () => null,
    createPullRequest: async () => '',
    pullRequestChecks: async () => ({ status: state.checks, failedRun: state.checks === 'failure' ? '77' : null }),
    pullRequestState: async () => ({ state: state.pr ?? 'open', approved: state.approved ?? false }),
    mergePullRequest: async (url) => void merged.push(url),
    failedRunLog: async () => state.log ?? '',
  };
  return { adapter, merged };
}

const REVIEW: ReviewRow = {
  id: 'abcdef12-0000-0000-0000-000000000000',
  name: 'Sprint 1: Äpfel',
  prUrl: 'https://github.com/a/b/pull/42',
  ciStatus: 'pending',
  ciBugRun: null,
  status: 'review',
};

/** Simuliert den Merge auf GitHub: Sprint-Branch im Bare-Repository nach main mergen. */
async function mergeOnGithub(remote: string): Promise<void> {
  const clone = await mkdtemp(join(tmpdir(), 'git-gh-'));
  execFileSync('git', ['clone', '-q', remote, clone]);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: clone, stdio: 'pipe' });
  git('config', 'user.email', 'gh@b.c');
  git('config', 'user.name', 'gh');
  git('fetch', 'origin', 'sprint/sprint-1-apfel');
  git('merge', '--no-ff', 'FETCH_HEAD', '-m', 'Merge pull request #42');
  git('push', 'origin', 'main');
}

test('green CI without required approval merges the pull request and tags main', async () => {
  const { cwd, remote, git } = await sprintRepository();
  git('push', '-u', 'origin', 'sprint/sprint-1-apfel');
  const { pool, updates } = reviewPool({ ...REVIEW });
  const { adapter, merged } = reviewAdapter({ checks: 'success' });
  adapter.mergePullRequest = async (url) => {
    merged.push(url);
    await mergeOnGithub(remote);
  };
  assert.equal(await pollSprintReviews(pool, 'p', cwd, adapter, false), 1);
  assert.deepEqual(merged, ['https://github.com/a/b/pull/42']);
  const tagged = execFileSync('git', ['rev-parse', 'refs/tags/sprint-sprint-1-apfel-abcdef^{commit}'], { cwd: remote })
    .toString()
    .trim();
  assert.equal(tagged, execFileSync('git', ['rev-parse', 'main'], { cwd: remote }).toString().trim());
  assert.equal(git('show', 'main:feature.txt'), 'neu');
  const final = updates.at(-1)!;
  assert.match(final.sql, /SET status = 'completed', ci_status = \$5, git_sync = 'done'/);
  assert.equal(final.values[4], 'success');
});

test('required approval: green CI waits until a human approves', async () => {
  const { cwd, remote, git } = await sprintRepository();
  git('push', '-u', 'origin', 'sprint/sprint-1-apfel');
  const sprint = { ...REVIEW };
  const { pool, updates } = reviewPool(sprint);
  const waiting = reviewAdapter({ checks: 'success', approved: false });
  assert.equal(await pollSprintReviews(pool, 'p', cwd, waiting.adapter, true), 0);
  assert.deepEqual(waiting.merged, []);
  assert.match(String(updates.at(-1)?.values[1]), /wartet auf Freigabe/);
  assert.equal(sprint.status, 'review');
  const approved = reviewAdapter({ checks: 'success', approved: true });
  approved.adapter.mergePullRequest = async (url) => {
    approved.merged.push(url);
    await mergeOnGithub(remote);
  };
  assert.equal(await pollSprintReviews(pool, 'p', cwd, approved.adapter, true), 1);
  assert.equal(approved.merged.length, 1);
});

test('red CI never merges and files one bug per run with a masked, shortened log excerpt', async () => {
  const { cwd } = await sprintRepository();
  const sprint = { ...REVIEW };
  const { pool, bugs } = reviewPool(sprint);
  process.env.DEVLOG_CI_TEST_SECRET = 'hunter2hunter2';
  try {
    const log = [
      ...Array.from({ length: 200 }, (_, index) => `test\tstep\tZeile ${index}`),
      'Error: login failed with hunter2hunter2',
      `token ghp_${'a'.repeat(36)} leaked`,
      'API_KEY=abcdefghijkl',
    ].join('\n');
    const red = reviewAdapter({ checks: 'failure', log });
    assert.equal(await pollSprintReviews(pool, 'p', cwd, red.adapter, false), 0);
    assert.equal(await pollSprintReviews(pool, 'p', cwd, red.adapter, false), 0);
    assert.deepEqual(red.merged, []);
    assert.equal(bugs.length, 1);
    const bug = bugs[0]!;
    assert.equal(bug.title, 'CI rot im Pull Request von „Sprint 1: Äpfel“');
    assert.match(bug.description, /Error: login failed with \[REDACTED\]/);
    assert.ok(!bug.description.includes('hunter2hunter2'));
    assert.ok(!bug.description.includes(`ghp_${'a'.repeat(36)}`));
    assert.ok(!bug.description.includes('abcdefghijkl'));
    assert.ok(!bug.description.includes('Zeile 0\n'));
    assert.ok(bug.description.length < 4_000);
    assert.equal(sprint.ciStatus, 'failure');
    assert.equal(sprint.status, 'review');
  } finally {
    delete process.env.DEVLOG_CI_TEST_SECRET;
  }
});

test('a pull request closed without merge ends the review as failed sync', async () => {
  const { cwd } = await sprintRepository();
  const sprint = { ...REVIEW };
  const { pool, updates } = reviewPool(sprint);
  const closed = reviewAdapter({ checks: 'pending', pr: 'closed' });
  assert.equal(await pollSprintReviews(pool, 'p', cwd, closed.adapter, false), 0);
  assert.match(updates.at(-1)!.sql, /git_sync = 'failed'/);
  assert.match(String(updates.at(-1)!.values[1]), /ohne Merge geschlossen/);
});

test('log excerpts mask known token formats and secret assignments', () => {
  const excerpt = ciLogExcerpt(`a\nPASSWORD: "geheim123"\nAKIAABCDEFGHIJKLMNOP\n`, {});
  assert.ok(!excerpt.includes('geheim123'));
  assert.ok(!excerpt.includes('AKIAABCDEFGHIJKLMNOP'));
  assert.equal(maskSecrets('nichts geheim', {}), 'nichts geheim');
});
