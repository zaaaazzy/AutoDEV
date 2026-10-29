import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { conflictSection, remainingConflicts } from './runner-steps.js';
import type { HosterAdapter } from './hoster.js';
import { goLive } from './go-live.js';
import { syncGitHub } from './github-sync.js';
import {
  ciLogExcerpt,
  maskSecrets,
  pollSprintReviews,
  checkoutSprintBranch,
  changedFiles,
  changedFilesSection,
  orderWorkInProgress,
  commitAgentStep,
  conflictPrompt,
  unresolvedConflicts,
  mergeIntoCheckedOutMain,
  ciWorkflowYaml,
  commitTaskToGit,
  filesWithSecrets,
  isValidGitRemote,
  pushRemote,
  enterOrderBranch,
  finishOrderBranch,
  mergeApprovedBranch,
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
  sprint: { name?: string; branch?: string | null; hasDone?: boolean } = {},
): { pool: Pool; updates: { sql: string; values: unknown[] }[] } {
  const updates: { sql: string; values: unknown[] }[] = [];
  let claimed = false;
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      updates.push({ sql, values });
      if (sql.includes("SET git_sync = 'running'") && !claimed) {
        claimed = true;
        return {
          rows: [
            {
              id: 'abcdef12-0000-0000-0000-000000000000',
              name: 'Sprint 1: Äpfel',
              action,
              remote,
              status,
              ...sprint,
            },
          ],
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

test('Sprint umbenennen nach dem ersten gemergten Auftrag: Abschluss enthält alle Aufträge', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'git-rename-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['init', '-b', 'main'], { cwd });
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  await writeFile(join(cwd, 'base.txt'), 'base');
  git('add', '-A');
  git('commit', '-m', 'base');

  // Branch beim Start festgehalten (sprints.branch); danach wird der Sprint umbenannt.
  const before = { name: 'Sprint 5', branch: 'sprint/sprint-5' };
  const first = { id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Erster Auftrag' };
  const one = await enterOrderBranch(cwd, first, before);
  assert.equal(one?.base, 'sprint/sprint-5');
  await writeFile(join(cwd, 'eins.txt'), '1');
  assert.equal((await finishOrderBranch(cwd, first, one!, before.name, true)).merged, true);

  const renamed = { name: 'Sprint 5 – Zahlungen', branch: 'sprint/sprint-5' };
  const second = { id: 'bbbbbbbb-0000-4000-8000-000000000002', title: 'Zweiter Auftrag' };
  const two = await enterOrderBranch(cwd, second, renamed);
  assert.equal(two?.base, 'sprint/sprint-5', 'nach dem Umbenennen kein neuer Branch von main');
  await writeFile(join(cwd, 'zwei.txt'), '2');
  assert.equal((await finishOrderBranch(cwd, second, two!, renamed.name, true)).merged, true);
  assert.equal(git('branch', '--list', 'sprint/*'), '* sprint/sprint-5');

  const { pool, updates } = fakePool(null, 'push', [['true']], 'completed', { ...renamed, hasDone: true });
  assert.equal(await syncSprintToGit(pool, 'p', cwd), 1);
  assert.match(updates.at(-1)?.sql ?? '', /git_sync = 'done'/);
  assert.equal(git('show', 'main:eins.txt'), '1', 'Auftrag vor der Umbenennung ist in main');
  assert.equal(git('show', 'main:zwei.txt'), '2');
  assert.match(git('log', 'main', '-1', '--format=%s'), /^Merge sprint\/sprint-5: Sprint Sprint 5 – Zahlungen/);
  const tag = sprintTag(renamed.name, 'abcdef12-0000-0000-0000-000000000000');
  assert.equal(git('rev-parse', `${tag}^{commit}`), git('rev-parse', 'main'), 'Tag zeigt auf den vollständigen Stand');
});

test('Sprint-Abschluss ohne Sprint-Branch, aber mit erledigten Aufträgen: gescheitert statt „done“', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'git-missing-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['init', '-b', 'main'], { cwd });
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  await writeFile(join(cwd, 'base.txt'), 'base');
  git('add', '-A');
  git('commit', '-m', 'base');
  await writeFile(join(cwd, 'lose.txt'), 'nicht vom Sprint');
  const head = git('rev-parse', 'main');

  const { pool, updates } = fakePool(null, 'push', [['true']], 'completed', {
    name: 'Sprint 7',
    branch: 'sprint/sprint-7',
    hasDone: true,
  });
  assert.equal(await syncSprintToGit(pool, 'p', cwd), 0);
  const final = updates.at(-1);
  assert.match(final?.sql ?? '', /git_sync = 'failed'/);
  assert.match(String(final?.values[1]), /Sprint-Branch sprint\/sprint-7 fehlt/);
  assert.equal(git('rev-parse', 'main'), head, 'main unverändert, kein Sicherungs-Commit');
  assert.equal(git('tag'), '', 'kein Tag auf einem fremden Stand');
});

test('ein gescheiterter Deploy wird nicht als „Live geschaltet“ gemeldet', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'git-live-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['init', '-b', 'main'], { cwd });
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  await writeFile(join(cwd, 'base.txt'), 'base');
  git('add', '-A');
  git('commit', '-m', 'base');
  await checkoutSprintBranch(cwd, 'Sprint 1: Äpfel');
  await writeFile(join(cwd, 'feature.txt'), 'neu');
  git('add', '-A');
  git('commit', '-m', 'feat: Auftrag');
  const { pool, updates } = fakePool(null, 'push', [['true']], 'completed');
  assert.equal(await syncSprintToGit(pool, 'p', cwd, undefined, async () => false), 1);
  const message = String(updates.at(-1)?.values[1]);
  assert.match(message, /Live schalten unvollständig: Deploy fehlgeschlagen/);
  assert.doesNotMatch(message, /Live geschaltet/);
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
      if (command.join(' ') === 'git rev-parse HEAD') return { exitCode: 0, durationMs: 1, output: 'abc1234\n' };
      if (command.includes('--porcelain')) return { exitCode: 0, durationMs: 1, output: dirty };
      if (command[0] === 'npm') return { exitCode: gateFails ? 1 : 0, durationMs: 1, output: 'rot' };
      return { exitCode: 0, durationMs: 1, output: '' };
    };
    return { calls, execute };
  };
  const clean = run('');
  assert.equal(
    await mergeIntoCheckedOutMain(clean.execute, '/human', 'sprint/s1', 'S1', [['npm', 'test']], []),
    'merged',
  );
  assert.ok(clean.calls.some((call) => call.startsWith('git merge --no-ff sprint/s1')));

  // Offene Änderungen: Der Mensch übernimmt selbst (wartet auf Merge), nichts angefasst.
  const busy = run(' M src/app.ts\n');
  assert.equal(await mergeIntoCheckedOutMain(busy.execute, '/human', 'sprint/s1', 'S1', [], []), 'busy');
  assert.ok(!busy.calls.some((call) => call.startsWith('git merge')));

  const red = run('', true);
  assert.equal(
    await mergeIntoCheckedOutMain(red.execute, '/human', 'sprint/s1', 'S1', [['npm', 'test']], []),
    'failed',
  );
  // Zurück auf den Stand vor dem Merge (nicht ORIG_HEAD, den das Test-Gate verschoben haben kann).
  assert.ok(red.calls.includes('git reset --keep abc1234'));
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

test('PR-Modus: nach dem Merge des Pull Requests wird live geschaltet (Deploy und production_deploys)', async () => {
  const { cwd, remote, git } = await sprintRepository();
  git('push', '-u', 'origin', 'sprint/sprint-1-apfel');
  // Der Projektordner steht wie im Betrieb sauber auf main (sonst wird bewusst nicht deployt).
  git('checkout', '-q', 'main');
  const { pool: review, updates } = reviewPool({ ...REVIEW });
  const deploys: unknown[][] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('deploy_commands')) return { rows: [{ commands: [['true']] }] };
      if (sql.includes('INSERT INTO production_deploys')) deploys.push(values);
      return review.query(sql, values);
    },
  } as unknown as Pool;
  const { adapter } = reviewAdapter({ checks: 'success' });
  adapter.mergePullRequest = () => mergeOnGithub(remote);
  assert.equal(await pollSprintReviews(pool, 'p', cwd, adapter, false, undefined, () => goLive(pool, 'p', cwd)), 1);
  // Ohne abgeschlossene Sprints im Test-Pool ist der Sprint-Tag unbekannt (null), Migrationen ungeprüft (null).
  assert.deepEqual(deploys, [['p', null, null]]);
  assert.ok(
    updates.some((entry) => /SET deploy_status/.test(entry.sql) && /Aktualisiert/.test(String(entry.values[1]))),
  );
  assert.match(String(updates.at(-1)?.values[1]), /Live geschaltet: .*deployt/);
});

/** Review-Pool mit Projektordner (projects.repository) und Deploy-Befehlen; zählt production_deploys-Einträge. */
function livePool(repository: string, separate: boolean) {
  const { pool: review, updates } = reviewPool({ ...REVIEW });
  const deploys: unknown[][] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('SELECT repository')) return { rows: [{ repository, separate }] };
      if (sql.includes('deploy_commands')) return { rows: [{ commands: [['true']] }] };
      if (sql.includes('INSERT INTO production_deploys')) deploys.push(values);
      return review.query(sql, values);
    },
  } as unknown as Pool;
  return { pool, updates, deploys };
}

const finalMessage = (updates: { sql: string; values: unknown[] }[]) =>
  String(updates.filter((entry) => /SET status = 'completed'/.test(entry.sql)).at(-1)?.values[1]);

test('PR-Modus ohne eigenen Agent-Ordner: Projektordner wechselt vom Sprint-Branch auf main und geht live', async () => {
  const { cwd, remote, git } = await sprintRepository();
  git('push', '-u', 'origin', 'sprint/sprint-1-apfel');
  const { pool, updates, deploys } = livePool(cwd, false);
  const { adapter } = reviewAdapter({ checks: 'success' });
  adapter.mergePullRequest = () => mergeOnGithub(remote);
  assert.equal(await pollSprintReviews(pool, 'p', cwd, adapter, false, undefined, () => goLive(pool, 'p', cwd)), 1);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git('rev-parse', 'HEAD'), execFileSync('git', ['rev-parse', 'main'], { cwd: remote }).toString().trim());
  assert.equal(git('show', 'HEAD:feature.txt'), 'neu', 'deployt wird main mit dem Sprint, nicht der Sprint-Branch');
  assert.equal(deploys.length, 1);
  assert.match(finalMessage(updates), /Live geschaltet: .*deployt/);
});

test('PR-Modus ohne eigenen Agent-Ordner: offene Änderungen oder fremder Branch – kein Wechsel, kein Deploy', async () => {
  // Offene Änderung auf dem Sprint-Branch: bleibt erhalten, nichts wird ausgecheckt oder deployt.
  const dirty = await sprintRepository();
  dirty.git('push', '-u', 'origin', 'sprint/sprint-1-apfel');
  await writeFile(join(dirty.cwd, 'feature.txt'), 'von Hand');
  const first = livePool(dirty.cwd, false);
  const one = reviewAdapter({ checks: 'success' });
  one.adapter.mergePullRequest = () => mergeOnGithub(dirty.remote);
  assert.equal(
    await pollSprintReviews(first.pool, 'p', dirty.cwd, one.adapter, false, undefined, () =>
      goLive(first.pool, 'p', dirty.cwd),
    ),
    1,
  );
  assert.equal(dirty.git('rev-parse', '--abbrev-ref', 'HEAD'), 'sprint/sprint-1-apfel');
  assert.equal(await readFile(join(dirty.cwd, 'feature.txt'), 'utf8'), 'von Hand');
  assert.deepEqual(first.deploys, []);
  assert.match(finalMessage(first.updates), /offene Änderungen/);
  assert.doesNotMatch(finalMessage(first.updates), /Live geschaltet/);

  // Projektordner auf einem fremden Branch (nicht dem des Sprints): bleibt dort.
  const foreign = await sprintRepository();
  foreign.git('push', '-u', 'origin', 'sprint/sprint-1-apfel');
  foreign.git('checkout', '-q', '-b', 'feature/mensch', 'main');
  const second = livePool(foreign.cwd, false);
  const two = reviewAdapter({ checks: 'success' });
  two.adapter.mergePullRequest = () => mergeOnGithub(foreign.remote);
  assert.equal(
    await pollSprintReviews(second.pool, 'p', foreign.cwd, two.adapter, false, undefined, () =>
      goLive(second.pool, 'p', foreign.cwd),
    ),
    1,
  );
  assert.equal(foreign.git('rev-parse', '--abbrev-ref', 'HEAD'), 'feature/mensch');
  assert.deepEqual(second.deploys, []);
  assert.match(finalMessage(second.updates), /feature\/mensch/);
});

/** Eigener Agent-Ordner (Worktree auf dem Sprint-Branch); der Projektordner (Live-Ordner) steht auf main. */
async function agentWorktreeLayout() {
  const repo = await sprintRepository();
  repo.git('push', '-u', 'origin', 'sprint/sprint-1-apfel');
  repo.git('checkout', '-q', 'main');
  const agents = join(await mkdtemp(join(tmpdir(), 'git-agents-')), 'agents');
  repo.git('worktree', 'add', '-q', agents, 'sprint/sprint-1-apfel');
  return { ...repo, live: repo.cwd, agents };
}

test('PR-Modus mit eigenem Agent-Ordner: main im Live-Ordner nachgezogen, live geschaltet, production_deploys', async () => {
  const { live, agents, remote, git } = await agentWorktreeLayout();
  const { pool, updates, deploys } = livePool(live, true);
  const { adapter } = reviewAdapter({ checks: 'success' });
  adapter.mergePullRequest = () => mergeOnGithub(remote);
  assert.equal(
    await pollSprintReviews(pool, 'p', agents, adapter, false, undefined, () => goLive(pool, 'p', agents)),
    1,
  );
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git('show', 'HEAD:feature.txt'), 'neu');
  assert.equal(deploys.length, 1);
  assert.match(finalMessage(updates), /Live geschaltet: .*deployt/);
});

test('PR-Modus mit eigenem Agent-Ordner: Live-Ordner als losgelöste Vorschau wird auf main gesetzt und deployt', async () => {
  const { live, agents, remote, git } = await agentWorktreeLayout();
  git('checkout', '-q', '--detach', 'sprint/sprint-1-apfel');
  const { pool, deploys } = livePool(live, true);
  const { adapter } = reviewAdapter({ checks: 'success' });
  adapter.mergePullRequest = () => mergeOnGithub(remote);
  assert.equal(
    await pollSprintReviews(pool, 'p', agents, adapter, false, undefined, () => goLive(pool, 'p', agents)),
    1,
  );
  assert.equal(git('rev-parse', 'HEAD'), execFileSync('git', ['rev-parse', 'main'], { cwd: remote }).toString().trim());
  assert.equal(deploys.length, 1);
});

test('PR-Modus mit eigenem Agent-Ordner: Live-Ordner unsauber oder auf fremdem Branch – kein Deploy', async () => {
  const dirty = await agentWorktreeLayout();
  await writeFile(join(dirty.live, 'base.txt'), 'von Hand');
  const first = livePool(dirty.live, true);
  const one = reviewAdapter({ checks: 'success' });
  one.adapter.mergePullRequest = () => mergeOnGithub(dirty.remote);
  await pollSprintReviews(first.pool, 'p', dirty.agents, one.adapter, false, undefined, () =>
    goLive(first.pool, 'p', dirty.agents),
  );
  assert.equal(await readFile(join(dirty.live, 'base.txt'), 'utf8'), 'von Hand');
  assert.deepEqual(first.deploys, []);
  assert.match(finalMessage(first.updates), /offene Änderungen/);

  const foreign = await agentWorktreeLayout();
  foreign.git('checkout', '-q', '-b', 'feature/mensch');
  const second = livePool(foreign.live, true);
  const two = reviewAdapter({ checks: 'success' });
  two.adapter.mergePullRequest = () => mergeOnGithub(foreign.remote);
  await pollSprintReviews(second.pool, 'p', foreign.agents, two.adapter, false, undefined, () =>
    goLive(second.pool, 'p', foreign.agents),
  );
  assert.equal(foreign.git('rev-parse', '--abbrev-ref', 'HEAD'), 'feature/mensch');
  assert.deepEqual(second.deploys, []);
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

/** Review-Pool mit Projekteinstellungen für syncGitHub; die GitHub-Brücke steht auf `aus`. */
function bridgeOffPool(sprint: ReviewRow) {
  const review = reviewPool(sprint);
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('FROM projects WHERE slug')) {
        review.updates.push({ sql, values });
        return {
          rows: [
            {
              mode: 'aus',
              remote: 'https://github.com/a/b.git',
              requireApproval: false,
              syncedAt: null,
              auth: 'ok',
              authCheckedAt: new Date(),
            },
          ],
        };
      }
      return review.pool.query(sql, values);
    },
  } as unknown as Pool;
  return { ...review, pool };
}

test('Brücke aus: Sprint im Review wird nach grüner CI trotzdem gemergt, getaggt und abgeschlossen', async () => {
  const { cwd, remote, git } = await sprintRepository();
  git('push', '-u', 'origin', 'sprint/sprint-1-apfel');
  const sprint = { ...REVIEW };
  const { pool, updates } = bridgeOffPool(sprint);
  const { adapter, merged } = reviewAdapter({ checks: 'success' });
  const listed: string[] = [];
  adapter.listIssues = async (label) => (listed.push(label), []);
  adapter.mergePullRequest = async (url) => {
    merged.push(url);
    await mergeOnGithub(remote);
  };
  const result = await syncGitHub(pool, 'bruecke-aus-ci', cwd, runCommand, new Date(), () => adapter);
  assert.equal(result.skipped, undefined);
  assert.equal(result.finished, 1);
  assert.deepEqual(merged, ['https://github.com/a/b/pull/42']);
  assert.equal(sprint.status, 'completed');
  assert.ok(execFileSync('git', ['tag', '-l', 'sprint-sprint-1-apfel-abcdef'], { cwd: remote }).toString().trim());
  // Der Issue-Import bleibt im Modus „aus“ abgeschaltet.
  assert.deepEqual(listed, []);
  assert.ok(!updates.some((update) => update.sql.includes('SET github_synced_at')));
  // Zweiter Takt nach dem Intervall: nichts mehr im Review, also kein gh-Aufruf und kein zweiter Merge.
  const later = new Date(Date.now() + 10 * 60_000);
  assert.equal((await syncGitHub(pool, 'bruecke-aus-ci', cwd, runCommand, later, () => adapter)).skipped, 'Modus aus');
  assert.equal(merged.length, 1);
});

test('Brücke aus: von Hand gemergter Pull Request schliesst den Sprint ab', async () => {
  const { cwd, remote, git } = await sprintRepository();
  git('push', '-u', 'origin', 'sprint/sprint-1-apfel');
  await mergeOnGithub(remote);
  const sprint = { ...REVIEW };
  const { pool } = bridgeOffPool(sprint);
  const { adapter, merged } = reviewAdapter({ checks: 'success', pr: 'merged' });
  const result = await syncGitHub(pool, 'bruecke-aus-hand', cwd, runCommand, new Date(), () => adapter);
  assert.equal(result.finished, 1);
  assert.deepEqual(merged, []);
  assert.equal(sprint.status, 'completed');
  assert.ok(execFileSync('git', ['tag', '-l', 'sprint-sprint-1-apfel-abcdef'], { cwd: remote }).toString().trim());
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

/** Auftrags-Branch und Sprint-Branch ändern dieselbe Zeile: beim Nachziehen entsteht ein Konflikt. */
async function conflictingOrder() {
  const cwd = await mkdtemp(join(tmpdir(), 'git-conflict-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['init', '-b', 'main'], { cwd });
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  await writeFile(join(cwd, 'liste.txt'), 'basis\n');
  git('add', '-A');
  git('commit', '-m', 'base');
  const item = { id: '99999999-2222-3333-4444-555555555555', title: 'Liste' };
  const first = await enterOrderBranch(cwd, item, 'Sprint 1');
  await writeFile(join(cwd, 'liste.txt'), 'basis\nauftrag\n');
  await finishOrderBranch(cwd, item, first!, 'Sprint 1', false);
  // Inzwischen landet ein anderer Auftrag im Sprint-Branch.
  await writeFile(join(cwd, 'liste.txt'), 'basis\nanderer auftrag\n');
  git('commit', '-am', 'anderer Auftrag');
  return { cwd, git, item };
}

test('Merge-Konflikt beim Nachziehen bleibt stehen, bis ein Agent ihn löst, und wird dann als Merge committet', async () => {
  const { cwd, git, item } = await conflictingOrder();
  const retry = await enterOrderBranch(cwd, item, 'Sprint 1');
  assert.deepEqual(retry?.conflicts, ['liste.txt']);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'auftrag/99999999-liste');
  assert.match(conflictPrompt(retry!), /Merge-Konflikte lösen[\s\S]*`liste.txt`[\s\S]*beider Seiten/);

  // Mit Markern wird nichts committet.
  assert.equal(await commitAgentStep(cwd, item, 'Tester', 'Sprint 1', true), null);
  assert.deepEqual(await unresolvedConflicts(cwd), ['liste.txt']);

  // Der Entwickler übernimmt beide Seiten; der Commit danach schliesst den Merge ab.
  await writeFile(join(cwd, 'liste.txt'), 'basis\nauftrag\nanderer auftrag\n');
  assert.deepEqual(await unresolvedConflicts(cwd), []);
  assert.ok(await commitAgentStep(cwd, item, 'Entwickler', 'Sprint 1', true));
  assert.equal(git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, 'Merge-Commit');
  const done = await finishOrderBranch(cwd, item, retry!, 'Sprint 1', true);
  assert.equal(done.merged, true);
  assert.equal(await readFile(join(cwd, 'liste.txt'), 'utf8'), 'basis\nauftrag\nanderer auftrag\n');
});

test('Ungelöste Konflikte werden am Ende verworfen statt mit Markern committet', async () => {
  const { cwd, git, item } = await conflictingOrder();
  const retry = await enterOrderBranch(cwd, item, 'Sprint 1');
  assert.deepEqual(retry?.conflicts, ['liste.txt']);
  // Der Entwickler hat angefangen, aber die Marker nicht entfernt: seine Arbeit darf nicht verloren gehen.
  const conflicted = await readFile(join(cwd, 'liste.txt'), 'utf8');
  await writeFile(join(cwd, 'liste.txt'), `${conflicted}entwickler-arbeit\n`);
  const result = await finishOrderBranch(cwd, item, retry!, 'Sprint 1', false);
  assert.equal(result.merged, false);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'sprint/sprint-1');
  assert.equal(git('status', '--porcelain'), '');
  assert.doesNotMatch(git('show', 'auftrag/99999999-liste:liste.txt'), /<<<<<<<|>>>>>>>/);
  // Kein WIP-Commit möglich: die Meldung nennt den Patch statt eines angeblich gesicherten Zwischenstands.
  assert.doesNotMatch(result.message, /Zwischenstand auf/);
  const patch = /Patch gesichert in (\S+\.patch)/.exec(result.message)?.[1];
  assert.ok(patch, result.message);
  assert.match(await readFile(patch, 'utf8'), /\+entwickler-arbeit/);
});

test('Fortsetzen auf dem Auftrags-Branch behält offene Merge-Konflikte (Neustart des Workers)', async () => {
  const { cwd, git, item } = await conflictingOrder();
  const first = await enterOrderBranch(cwd, item, 'Sprint 1');
  assert.deepEqual(first?.conflicts, ['liste.txt']);
  const conflicted = await readFile(join(cwd, 'liste.txt'), 'utf8');

  // Neustart: Der Ordner steht schon auf dem Auftrags-Branch, der Merge ist noch offen.
  const resumed = await enterOrderBranch(cwd, item, 'Sprint 1');
  assert.deepEqual(resumed, { branch: 'auftrag/99999999-liste', base: 'sprint/sprint-1', conflicts: ['liste.txt'] });
  // Der Prompt des nächsten Agents (runStep) beginnt mit dem Konfliktabschnitt.
  assert.match(conflictSection(resumed), /^## Zuerst: Merge-Konflikte lösen[\s\S]*`liste.txt`[\s\S]*\n\n$/);
  // Weder Abort noch Reset: MERGE_HEAD und die Marker bleiben stehen.
  assert.ok(git('rev-parse', '-q', '--verify', 'MERGE_HEAD'));
  assert.equal(await readFile(join(cwd, 'liste.txt'), 'utf8'), conflicted);
  assert.equal(await commitAgentStep(cwd, item, 'Entwickler', 'Sprint 1', true), null);
  // Lässt der Agent die Marker stehen, ist der Schritt nicht bestanden (Prüfung nach dem Schritt in runStep).
  assert.deepEqual(await remainingConflicts(cwd, runCommand), ['liste.txt']);

  // Ohne offenen Merge bleibt das Ergebnis wie bisher (kein leeres conflicts-Feld).
  await writeFile(join(cwd, 'liste.txt'), 'basis\nauftrag\nanderer auftrag\n');
  assert.deepEqual(await remainingConflicts(cwd, runCommand), []);
  assert.ok(await commitAgentStep(cwd, item, 'Entwickler', 'Sprint 1', true));
  assert.deepEqual(await enterOrderBranch(cwd, item, 'Sprint 1'), {
    branch: 'auftrag/99999999-liste',
    base: 'sprint/sprint-1',
  });
});

test('unresolvedConflicts wirft, wenn git scheitert, statt „keine Konflikte“ zu melden', async () => {
  const execute = (async () => ({
    exitCode: 128,
    durationMs: 0,
    output: 'fatal: index kaputt',
  })) as unknown as CommandExecutor;
  await assert.rejects(unresolvedConflicts('/repo', execute), /Konfliktprüfung fehlgeschlagen/);
  // Nach dem Schritt gilt das als offener Konflikt: der Schritt scheitert, statt zu bestehen.
  const remaining = await remainingConflicts('/repo', execute);
  assert.equal(remaining.length, 1);
  assert.match(remaining[0]!, /Prüfung fehlgeschlagen: Konfliktprüfung fehlgeschlagen: fatal: index kaputt/);
});

test('Fortsetzen ohne offenen Merge liefert keine Konflikte und keinen Konfliktabschnitt', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'git-resume-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['init', '-b', 'main'], { cwd });
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  await writeFile(join(cwd, 'liste.txt'), 'basis\n');
  git('add', '-A');
  git('commit', '-m', 'base');
  const item = { id: '99999999-6666-7777-8888-999999999999', title: 'Sauber' };
  await enterOrderBranch(cwd, item, 'Sprint 1');
  // Abbruch mitten im Schritt: offene Änderung, aber kein Merge.
  await writeFile(join(cwd, 'liste.txt'), 'basis\nangefangen\n');
  const resumed = await enterOrderBranch(cwd, item, 'Sprint 1');
  assert.deepEqual(resumed, { branch: 'auftrag/99999999-sauber', base: 'sprint/sprint-1' });
  assert.equal(conflictSection(resumed), '');
  assert.equal(await readFile(join(cwd, 'liste.txt'), 'utf8'), 'basis\nangefangen\n');
});

test('Git-Sicherung wartet, solange ein unterbrochener Auftrag offene Änderungen im Ordner hat', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'git-wait-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['init', '-b', 'main'], { cwd });
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  await writeFile(join(cwd, 'a.txt'), 'a');
  git('add', '-A');
  git('commit', '-m', 'base');
  git('checkout', '-b', 'auftrag/12345678-halb-fertig');
  await writeFile(join(cwd, 'a.txt'), 'halb fertig');
  assert.equal(await orderWorkInProgress(cwd), true);
  const { pool, updates } = fakePool(null);
  assert.equal(await syncSprintToGit(pool, 'p', cwd), 0);
  assert.equal(
    updates.some((update) => update.sql.includes("git_sync = 'running'") && !update.sql.includes('60 minutes')),
    false,
    'nichts übernommen, Sprint bleibt pending',
  );
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'auftrag/12345678-halb-fertig');
  // Committet oder auf einem anderen Branch: die Sicherung läuft wieder.
  git('commit', '-am', 'wip');
  assert.equal(await orderWorkInProgress(cwd), false);
});

test('Git-Sicherung wartet auch, wenn der unterbrochene Auftrag nur neue Dateien angelegt hat', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'git-wait-new-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['init', '-b', 'main'], { cwd });
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  await writeFile(join(cwd, 'a.txt'), 'a');
  git('add', '-A');
  git('commit', '-m', 'base');
  git('checkout', '-b', 'auftrag/12345678-nur-neue-datei');
  await mkdir(join(cwd, 'src'), { recursive: true });
  await writeFile(join(cwd, 'src', 'halb-fertig.ts'), 'export const x = 1;');
  assert.equal(await orderWorkInProgress(cwd), true);
  const { pool, updates } = fakePool(null);
  assert.equal(await syncSprintToGit(pool, 'p', cwd), 0);
  assert.equal(
    updates.some((update) => update.sql.includes("git_sync = 'running'") && !update.sql.includes('60 minutes')),
    false,
    'nichts übernommen, Sprint bleibt pending',
  );
  // Kein Checkout, kein Commit: die neue Datei bleibt unversioniert auf dem Auftrags-Branch.
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'auftrag/12345678-nur-neue-datei');
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '?? src/halb-fertig.ts');
  assert.equal(git('rev-list', '--count', 'HEAD'), '1');
});

test('Testberichte und Agent-Ablage allein halten die Git-Sicherung nicht auf', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'git-wait-ignored-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['init', '-b', 'main'], { cwd });
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  await writeFile(join(cwd, 'a.txt'), 'a');
  git('add', '-A');
  git('commit', '-m', 'base');
  git('checkout', '-b', 'auftrag/12345678-nur-ablage');
  await mkdir(join(cwd, '.dev-log'), { recursive: true });
  await mkdir(join(cwd, 'docs', 'tests'), { recursive: true });
  await writeFile(join(cwd, '.dev-log', 'notiz.md'), 'notiz');
  await writeFile(join(cwd, 'docs', 'tests', 'bericht.md'), 'bericht');
  assert.equal(await orderWorkInProgress(cwd), false);
});

test('geänderte Dateien eines Auftrags: Commits seit der Basis plus offene, neue und gelöschte Dateien', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'git-changed-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['init', '-b', 'main'], { cwd });
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  await writeFile(join(cwd, 'base.txt'), 'base');
  await writeFile(join(cwd, 'alt.txt'), 'alt');
  await writeFile(join(cwd, 'unberührt.txt'), 'bleibt');
  git('add', '-A');
  git('commit', '-m', 'base');
  const branch = await enterOrderBranch(cwd, { id: '22222222-0000', title: 'Dateien' }, null);
  assert.ok(branch);
  assert.deepEqual(await changedFiles(cwd, branch.base), []);
  assert.equal(changedFilesSection([]), '## Geänderte Dateien\nKeine Dateien geändert.');
  // Committet: geänderte und gelöschte Datei; offen: geänderte, neue und interne Dateien.
  await writeFile(join(cwd, 'base.txt'), 'neu');
  git('rm', '-q', 'alt.txt');
  git('add', '-A');
  git('commit', '-m', 'schritt');
  await writeFile(join(cwd, 'base.txt'), 'noch neuer');
  await writeFile(join(cwd, 'zäh.ts'), 'export {}');
  await mkdir(join(cwd, '.dev-log'), { recursive: true });
  await mkdir(join(cwd, 'docs', 'tests'), { recursive: true });
  await writeFile(join(cwd, '.dev-log', 'notiz.md'), 'intern');
  await writeFile(join(cwd, 'docs', 'tests', 'bericht.md'), 'intern');
  const files = await changedFiles(cwd, branch.base);
  assert.deepEqual(files, [
    { path: 'alt.txt', deleted: true },
    { path: 'base.txt', deleted: false },
    { path: 'zäh.ts', deleted: false },
  ]);
  assert.equal(changedFilesSection(files), '## Geänderte Dateien\n- alt.txt (gelöscht)\n- base.txt\n- zäh.ts');
  assert.deepEqual(await changedFiles(await mkdtemp(join(tmpdir(), 'git-nogit-')), 'main'), []);
});

test('Live schalten deployt nicht aus einem Projektordner auf fremdem Branch oder mit offenen Änderungen', async () => {
  const { cwd, git } = await sprintRepository();
  const updates: unknown[][] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('SELECT repository')) return { rows: [{ repository: cwd }] };
      if (sql.includes('deploy_commands')) return { rows: [{ commands: [['true']] }] };
      if (sql.includes('SET deploy_status')) updates.push(values);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  // Steht auf dem Sprint-Branch (Stand eines fremden Branchs).
  await assert.rejects(goLive(pool, 'p', cwd), /nicht deployt – Projektordner .* steht auf sprint\/sprint-1-apfel/);
  assert.match(String(updates.at(-1)?.[1]), /^Nicht deployt:/);
  git('checkout', '-q', 'main');
  await writeFile(join(cwd, 'offen.txt'), 'x');
  git('add', 'offen.txt');
  await assert.rejects(goLive(pool, 'p', cwd), /1 offene Änderung/);
  git('reset', '-q', 'offen.txt');
  assert.equal(await goLive(pool, 'p', cwd), true);
});

// Früher hiess die Sicherung „done“, obwohl der Sprint nie in main ankam (main im Ordner der Menschen ausgecheckt, dort
// offene Änderungen) – der Autopilot meldete „ready“, und der nächste Sprint zweigte vom alten main ab. Jetzt wartet
// der Sprint auf den Merge (auch mit restart_after_sprint: kein Neustart) und wird „done“, sobald main ihn enthält.
test('Sprint-Sicherung: main in anderem Ordner mit offenen Änderungen → wartet auf Merge, danach „done“', async () => {
  const human = await mkdtemp(join(tmpdir(), 'git-sync-human-'));
  const agents = `${human}-agents`;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, stdio: 'pipe', env }).toString().trim();
  run(human, 'init', '-q', '-b', 'main');
  await writeFile(join(human, 'a.txt'), 'a\n');
  run(human, 'add', '-A');
  run(human, 'commit', '-q', '-m', 'eins');
  run(human, 'worktree', 'add', '-q', '-b', 'sprint/sprint-1-apfel', agents, 'main');
  await writeFile(join(agents, 'sprint.txt'), 'sprint\n');
  run(agents, 'add', '-A');
  run(agents, 'commit', '-q', '-m', 'sprint');
  await writeFile(join(human, 'a.txt'), 'Mensch arbeitet\n');
  for (const restart of [false, true]) {
    const { pool, updates } = fakePool(null, 'push', [['true']], 'completed');
    const query = pool.query.bind(pool) as (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
    (pool as unknown as { query: typeof query }).query = async (sql, values = []) => {
      if (sql.includes('restart_after_sprint AS restart')) return { rows: [{ restart }] };
      return query(sql, values);
    };
    assert.equal(await syncSprintToGit(pool, 'p', agents), 1);
    const waiting = updates.find((entry) => /SET git_sync = 'awaiting_merge'/.test(entry.sql));
    assert.ok(waiting, 'wartet auf Merge');
    assert.match(String(waiting.values[1]), /git merge sprint\/sprint-1-apfel/);
    assert.ok(!updates.some((entry) => /SET git_sync = '(done|failed)'/.test(entry.sql)), 'weder done noch failed');
    assert.ok(!updates.some((entry) => /INSERT INTO app_settings/.test(entry.sql)), 'kein Neustart angefordert');
    assert.equal(run(human, 'status', '--porcelain'), 'M a.txt');
    assert.equal(run(human, 'rev-list', '--count', 'main'), '1');
  }

  // Noch nicht gemergt: Die Prüfung lässt den Sprint warten.
  const commit = run(agents, 'rev-parse', '--short', 'sprint/sprint-1-apfel');
  const settle = () => {
    const updates: { sql: string; values: unknown[] }[] = [];
    const pool = {
      query: async (sql: string, values: unknown[] = []) => {
        updates.push({ sql, values });
        if (sql.includes("WHERE project_slug = $1 AND git_sync = 'awaiting_merge'"))
          return { rows: [{ id: 'abcdef12-0000-0000-0000-000000000000', name: 'Sprint 1: Äpfel', commit }] };
        return { rows: [] };
      },
    } as unknown as Pool;
    return { pool, updates };
  };
  const still = settle();
  assert.equal(await syncSprintToGit(still.pool, 'p', agents), 0);
  assert.ok(!still.updates.some((entry) => /SET git_sync = '(done|failed)'/.test(entry.sql)));

  // Der Mensch räumt auf und übernimmt den Sprint von Hand: Beim nächsten Durchlauf wird er „done“.
  run(human, 'checkout', '-q', '--', 'a.txt');
  run(human, 'merge', '-q', '--no-ff', '-m', 'Sprint übernommen', 'sprint/sprint-1-apfel');
  const merged = settle();
  await syncSprintToGit(merged.pool, 'p', agents);
  const done = merged.updates.find((entry) => /SET git_sync = 'done'/.test(entry.sql));
  assert.ok(done, 'nach dem Merge „done“');
  assert.match(done.sql, /WHERE id = \$1 AND git_sync = 'awaiting_merge'/, 'nur aus „wartet auf Merge“ heraus');

  // Ein Stand, den git nicht kennt, ist ein echter Fehler (Exit-Code ≠ 0/1): weder „done“ noch weiter „wartet“.
  const unknown = settle();
  const pool = unknown.pool as unknown as { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }> };
  const inner = pool.query;
  pool.query = async (sql, values = []) =>
    sql.includes("WHERE project_slug = $1 AND git_sync = 'awaiting_merge'")
      ? { rows: [{ id: 'abcdef12-0000-0000-0000-000000000000', name: 'Sprint 1: Äpfel', commit: 'deadbeef00' }] }
      : inner(sql, values);
  await syncSprintToGit(unknown.pool, 'p', agents);
  assert.ok(unknown.updates.some((entry) => /SET git_sync = 'failed'/.test(entry.sql)));
  assert.ok(!unknown.updates.some((entry) => /SET git_sync = 'done'/.test(entry.sql)));
});

// Konflikte oder rotes Test-Gate beim Merge in den Ordner der Menschen bleiben ein echter Fehler (Autopilot pausiert).
test('Sprint-Sicherung: main in anderem Ordner, Test-Gate dort rot → gescheitert, Merge zurückgenommen', async () => {
  const human = await mkdtemp(join(tmpdir(), 'git-sync-human-'));
  const agents = `${human}-agents`;
  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    })
      .toString()
      .trim();
  run(human, 'init', '-q', '-b', 'main');
  await writeFile(join(human, 'a.txt'), 'a\n');
  run(human, 'add', '-A');
  run(human, 'commit', '-q', '-m', 'eins');
  run(human, 'worktree', 'add', '-q', '-b', 'sprint/sprint-1-apfel', agents, 'main');
  await writeFile(join(agents, 'sprint.txt'), 'sprint\n');
  run(agents, 'add', '-A');
  run(agents, 'commit', '-q', '-m', 'sprint');
  // Ungetrackte Datei zählt nicht als offene Änderung, lässt aber das Test-Gate nur im Ordner der Menschen scheitern.
  await writeFile(join(human, 'rot.marker'), 'x');
  const gate = ['node', '-e', "process.exit(require('fs').existsSync('rot.marker') ? 1 : 0)"];
  const { pool, updates } = fakePool(null, 'push', [gate], 'completed');
  assert.equal(await syncSprintToGit(pool, 'p', agents), 0);
  const failed = updates.find((entry) => /git_sync = 'failed'/.test(entry.sql));
  assert.ok(failed, 'als gescheitert markiert');
  assert.match(
    String(failed.values.find((value) => typeof value === 'string' && value.includes('main'))),
    /noch nicht in main/,
  );
  assert.ok(!updates.some((entry) => /SET git_sync = '(done|awaiting_merge)'/.test(entry.sql)));
  assert.equal(run(human, 'status', '--porcelain'), '?? rot.marker');
  assert.equal(run(human, 'rev-list', '--count', 'main'), '1');
});

// Früher scheiterte die Freigabe eines Auftrags ohne Sprint im losgelösten Agent-Worktree mit „already used by
// worktree“ (git checkout main, während main im Ordner der Menschen ausgecheckt ist) – jede Freigabe endete blockiert.
test('Review-Freigabe: Basis main in anderem Worktree ausgecheckt → dort gemergt, bei offenen Änderungen nichts angefasst', async () => {
  const human = await mkdtemp(join(tmpdir(), 'git-sync-review-'));
  const agents = `${human}-agents`;
  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    })
      .toString()
      .trim();
  run(human, 'init', '-q', '-b', 'main');
  run(human, 'config', 'user.email', 't@t');
  run(human, 'config', 'user.name', 't');
  await writeFile(join(human, 'a.txt'), 'a\n');
  run(human, 'add', '-A');
  run(human, 'commit', '-q', '-m', 'eins');
  run(human, 'worktree', 'add', '-q', '--detach', agents, 'main');
  const branch = 'auftrag/aa11bb22-betrieb';
  run(agents, 'checkout', '-q', '-b', branch);
  await writeFile(join(agents, 'betrieb.txt'), 'betrieb\n');
  run(agents, 'add', '-A');
  run(agents, 'commit', '-q', '-m', 'betrieb');
  run(agents, 'checkout', '-q', '--detach', 'main');

  // Ordner der Menschen hat offene Änderungen: nicht mergen, dort nichts verändern, Branch bleibt.
  await writeFile(join(human, 'a.txt'), 'Mensch arbeitet\n');
  const blocked = await mergeApprovedBranch(agents, { title: 'Betrieb' }, branch, 'main');
  assert.equal(blocked.merged, false);
  assert.doesNotMatch(blocked.message, /already used by worktree/);
  assert.match(blocked.message, /Änderungen offen/);
  assert.equal(run(human, 'status', '--porcelain'), 'M a.txt');
  assert.equal(run(human, 'rev-list', '--count', 'main'), '1');
  assert.ok(run(agents, 'branch', '--list', branch));

  // Sauberer Ordner: Merge im Ordner der Menschen, Branch gelöscht, Agent-Ordner folgt main losgelöst.
  run(human, 'checkout', '-q', '--', 'a.txt');
  const merged = await mergeApprovedBranch(agents, { title: 'Betrieb' }, branch, 'main');
  assert.equal(merged.merged, true, merged.message);
  assert.equal(await readFile(join(human, 'betrieb.txt'), 'utf8'), 'betrieb\n');
  assert.equal(run(human, 'status', '--porcelain'), '');
  assert.equal(run(agents, 'branch', '--list', branch), '');
  assert.equal(run(agents, 'rev-parse', 'HEAD'), run(human, 'rev-parse', 'main'));
});

// A7: Nach dem Abschluss blieb der Agent-Ordner auf sprint/…; ein Auftrag ohne Sprint (Erneut versuchen, Bugfix) zweigte
// davon ab, wurde dorthin gemergt und kam nie in main.
test('Sprint-Sicherung: nach dem Merge in den Ordner der Menschen steht der Agent-Ordner losgelöst auf main', async () => {
  const human = await mkdtemp(join(tmpdir(), 'git-sync-human-'));
  const agents = `${human}-agents`;
  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    })
      .toString()
      .trim();
  run(human, 'init', '-q', '-b', 'main');
  await writeFile(join(human, 'a.txt'), 'a\n');
  run(human, 'add', '-A');
  run(human, 'commit', '-q', '-m', 'eins');
  run(human, 'worktree', 'add', '-q', '-b', 'sprint/sprint-1-apfel', agents, 'main');
  await writeFile(join(agents, 'sprint.txt'), 'sprint\n');
  run(agents, 'add', '-A');
  run(agents, 'commit', '-q', '-m', 'sprint');
  const { pool, updates } = fakePool(null, 'push', [['true']], 'completed');
  assert.equal(await syncSprintToGit(pool, 'p', agents), 1);
  assert.ok(updates.some((entry) => /git_sync = 'done'/.test(entry.sql)));
  assert.equal(run(human, 'show', 'main:sprint.txt'), 'sprint');
  assert.equal(run(agents, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'losgelöst');
  assert.equal(run(agents, 'rev-parse', 'HEAD'), run(human, 'rev-parse', 'main'));

  // Der nächste Auftrag ohne Sprint zweigt von main ab und wird am Ende in main gemergt.
  const item = { id: 'dddddddd-0000-4000-8000-000000000004', title: 'Retry ohne Sprint' };
  const branch = await enterOrderBranch(agents, item, null);
  assert.equal(branch?.base, 'main');
});

test('Auftrag ohne Sprint auf altem Sprint-Branch: setzt auf main auf, nicht auf dem Sprint', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'git-no-sprint-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' })
      .toString()
      .trim();
  git('init', '-q', '-b', 'main');
  await writeFile(join(cwd, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'eins');
  git('switch', '-q', '-c', 'sprint/sprint-7');
  await writeFile(join(cwd, 'alt.txt'), 'alter Sprint\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'sprint');
  const branch = await enterOrderBranch(cwd, { id: 'eeeeeeee-0000-4000-8000-000000000005', title: 'Bugfix' }, null);
  assert.equal(branch?.base, 'main');
  assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'main'), 'vom Stand von main, ohne den alten Sprint');

  // Branches der Menschen bleiben, wie sie sind (dort arbeitet der Auftrag wie bisher auf ihrem Branch).
  git('switch', '-q', 'main');
  git('branch', '-q', '-D', branch!.branch);
  git('switch', '-q', '-c', 'feature/eigenes');
  const human = await enterOrderBranch(cwd, { id: 'ffffffff-0000-4000-8000-000000000006', title: 'Auf Feature' }, null);
  assert.equal(human?.base, 'feature/eigenes');
});
