import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import type { CommandExecutor, CommandResult } from '../core/command.js';
import {
  createGithubAdapter,
  evaluateChecks,
  GH_COMMANDS,
  ghRunner,
  githubRepo,
  isPullRequestUrl,
  runIdFromLink,
  searchTimestamp,
} from './github.js';
import { HosterError } from './hoster.js';

/** Mock-Executor: zeichnet jeden Aufruf auf und liest --body-file-Inhalte, solange die Datei existiert. */
function recorder(reply: (command: string[]) => Partial<CommandResult> = () => ({})) {
  const calls: { command: string[]; options: Parameters<CommandExecutor>[2]; body?: string }[] = [];
  const execute: CommandExecutor = async (command, _cwd, options) => {
    const file = command[command.indexOf('--body-file') + 1];
    const body = command.includes('--body-file') && file && existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    calls.push({ command, options, body });
    return { exitCode: 0, durationMs: 1, output: '', ...reply(command) };
  };
  return { calls, execute };
}

test('derives owner/repo only from GitHub remotes and rejects odd names', () => {
  assert.equal(githubRepo('https://github.com/zaaaazzy/Mainty.git'), 'zaaaazzy/Mainty');
  assert.equal(githubRepo('git@github.com:a-b/c.d_e.git'), 'a-b/c.d_e');
  assert.equal(githubRepo('ssh://git@github.com/a/b'), 'a/b');
  assert.equal(githubRepo('https://gitlab.com/a/b.git'), null);
  assert.equal(githubRepo('https://github.com/a/b/c'), null);
  assert.equal(githubRepo('https://github.com/-a/b'), null);
  assert.equal(githubRepo('https://github.com/a/..'), null);
  assert.equal(githubRepo(null), null);
  assert.ok(isPullRequestUrl('https://github.com/a/b/pull/12', 'a/b'));
  assert.ok(!isPullRequestUrl('https://github.com/x/b/pull/12', 'a/b'));
  assert.ok(!isPullRequestUrl('https://github.com/a/b/pull/12;rm', 'a/b'));
});

test('every gh call runs without a shell, with a fixed subcommand and texts only via --body-file', async () => {
  const { calls, execute } = recorder((command) => {
    if (command[2] === 'list' && command[1] === 'issue')
      return {
        output: JSON.stringify([
          {
            number: 3,
            title: 'Absturz',
            body: '$(rm -rf /)',
            labels: [{ name: 'Bug' }],
            url: 'https://github.com/a/b/issues/3',
          },
        ]),
      };
    if (command[2] === 'list') return { output: '[]' };
    if (command[2] === 'create') return { output: 'https://github.com/a/b/pull/7\n' };
    if (command[2] === 'checks') return { output: '[]' };
    if (command[2] === 'view' && command[1] === 'pr') return { output: '{"state":"OPEN","reviewDecision":"APPROVED"}' };
    return {};
  });
  const adapter = createGithubAdapter('a/b', execute, '/tmp');
  assert.deepEqual(await adapter.authStatus(), { ok: true, message: 'Angemeldet (gh auth status).' });
  const issues = await adapter.listIssues('bug', new Date('2026-10-19T10:00:00.123Z'));
  assert.deepEqual(issues[0]?.labels, ['bug']);
  await adapter.commentIssue(3, 'Erledigt; `$(whoami)` "quoted"');
  await adapter.closeIssue(3);
  assert.equal(await adapter.findPullRequest('sprint/sprint-4'), null);
  const url = await adapter.createPullRequest({
    head: 'sprint/sprint-4',
    base: 'main',
    title: 'Sprint: S4',
    body: '# Bericht\n\n- `a`; b',
  });
  assert.equal(url, 'https://github.com/a/b/pull/7');
  await adapter.pullRequestChecks(url);
  assert.deepEqual(await adapter.pullRequestState(url), { state: 'open', approved: true });
  await adapter.mergePullRequest(url);
  await adapter.failedRunLog('123');

  for (const call of calls) {
    assert.equal(call.command[0], 'gh');
    assert.ok(GH_COMMANDS.has(`${call.command[1]} ${call.command[2]}`), call.command.join(' '));
    assert.equal(call.options?.env?.GH_PROMPT_DISABLED, '1');
    // Kein Argument enthält Shell-Text oder Zeilenumbrüche aus Daten.
    assert.ok(
      call.command.every((part) => !part.includes('\n') && !part.includes('$(')),
      call.command.join(' '),
    );
  }
  const search = calls.find((call) => call.command[1] === 'issue' && call.command[2] === 'list')!.command;
  assert.equal(search[search.indexOf('--search') + 1], 'updated:>=2026-10-19T10:00:00Z');
  const comment = calls.find((call) => call.command[2] === 'comment')!;
  assert.equal(comment.body, 'Erledigt; `$(whoami)` "quoted"');
  assert.equal(calls.find((call) => call.command[2] === 'create')!.body, '# Bericht\n\n- `a`; b');
  assert.deepEqual(calls.find((call) => call.command[2] === 'merge')!.command, [
    'gh',
    'pr',
    'merge',
    'https://github.com/a/b/pull/7',
    '--merge',
  ]);
  assert.ok(calls.find((call) => call.command[2] === 'close')!.command.includes('completed'));
});

test('rejects unknown subcommands, foreign pull requests and invalid data before calling gh', async () => {
  const { calls, execute } = recorder();
  const gh = ghRunner(execute, '/tmp');
  await assert.rejects(gh('api', 'user', []), /nicht erlaubt/);
  await assert.rejects(gh('repo', 'delete', ['a/b']), /nicht erlaubt/);
  const adapter = createGithubAdapter('a/b', execute);
  await assert.rejects(adapter.mergePullRequest('https://github.com/evil/x/pull/1'), /gehört nicht/);
  await assert.rejects(adapter.commentIssue(-1, 'x'), /Issue-Nummer/);
  await assert.rejects(adapter.findPullRequest('--upload-pack=x'), /Branch/);
  await assert.rejects(adapter.failedRunLog('1;2'), /Lauf/);
  await assert.rejects(adapter.listIssues('enhancement', null), /Label/);
  await assert.rejects(createGithubAdapter('a/b --x', execute).closeIssue(1), /Repository/);
  assert.equal(calls.length, 0);
});

test('reports a missing login with a clear hint and flags rate limits', async () => {
  const missing = createGithubAdapter(
    'a/b',
    recorder(() => ({ exitCode: 1, output: 'You are not logged into any GitHub hosts.' })).execute,
  );
  const auth = await missing.authStatus();
  assert.equal(auth.ok, false);
  assert.match(auth.message, /gh auth login/);
  const noCli = createGithubAdapter('a/b', recorder(() => ({ exitCode: 1, output: 'spawn gh ENOENT' })).execute);
  assert.match((await noCli.authStatus()).message, /fehlt/);
  const limited = createGithubAdapter(
    'a/b',
    recorder(() => ({ exitCode: 1, output: 'HTTP 403: API rate limit exceeded for user' })).execute,
  );
  await assert.rejects(limited.listIssues('idea', null), (error: unknown) => {
    assert.ok(error instanceof HosterError && error.rateLimited);
    return true;
  });
});

test('masks secrets from the environment in gh output', async () => {
  process.env.DEVLOG_TEST_TOKEN = 'supersecretvalue';
  try {
    const adapter = createGithubAdapter(
      'a/b',
      recorder(() => ({ output: 'step: token supersecretvalue used' })).execute,
    );
    assert.equal(await adapter.failedRunLog('5'), 'step: token [REDACTED] used');
  } finally {
    delete process.env.DEVLOG_TEST_TOKEN;
  }
});

test('evaluates pull request checks: red before pending before green', () => {
  const link = 'https://github.com/a/b/actions/runs/987/job/1';
  assert.deepEqual(evaluateChecks([]), { status: 'pending', failedRun: null });
  assert.deepEqual(evaluateChecks([{ bucket: 'pass' }, { bucket: 'skipping' }]), {
    status: 'success',
    failedRun: null,
  });
  assert.deepEqual(evaluateChecks([{ bucket: 'pass' }, { bucket: 'pending' }]), { status: 'pending', failedRun: null });
  assert.deepEqual(evaluateChecks([{ bucket: 'pending' }, { bucket: 'fail', link }]), {
    status: 'failure',
    failedRun: '987',
  });
  assert.equal(runIdFromLink('https://example.com'), null);
  assert.equal(searchTimestamp(new Date('2026-01-02T03:04:05.678Z')), '2026-01-02T03:04:05Z');
});

test('pending checks (exit code 8) and missing checks count as pending', async () => {
  const pending = createGithubAdapter(
    'a/b',
    recorder(() => ({ exitCode: 8, output: '[{"bucket":"pending","state":"IN_PROGRESS"}]' })).execute,
  );
  assert.equal((await pending.pullRequestChecks('https://github.com/a/b/pull/1')).status, 'pending');
  const none = createGithubAdapter(
    'a/b',
    recorder(() => ({ exitCode: 1, output: "no checks reported on the 'sprint/x' branch" })).execute,
  );
  assert.equal((await none.pullRequestChecks('https://github.com/a/b/pull/1')).status, 'pending');
  const red = createGithubAdapter(
    'a/b',
    recorder(() => ({
      exitCode: 1,
      output: '[{"bucket":"fail","link":"https://github.com/a/b/actions/runs/55/job/9"}]',
    })).execute,
  );
  assert.deepEqual(await red.pullRequestChecks('https://github.com/a/b/pull/1'), {
    status: 'failure',
    failedRun: '55',
  });
});
