import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { type CommandExecutor, runCommand } from '../../core/command.js';
import { enterOrderBranch, OrderBranchError, orderWorkInProgress, removeAgentWorktrees } from './order-branch.js';

function repository(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'dev-log-foreign-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(cwd, 'README.md'), 'Start\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Start');
  return cwd;
}

/** git läuft echt, nur „git status“ scheitert (z. B. Index gesperrt, Laufwerk weg). */
const statusFails: CommandExecutor = (command, cwd, options) =>
  command.includes('status')
    ? Promise.resolve({ exitCode: 128, durationMs: 0, output: 'fatal: Unable to read current working directory' })
    : runCommand(command, cwd, options);

test('enterOrderBranch: scheitert git status, gilt das nie als „keine fremden Änderungen“', async () => {
  const cwd = repository();
  try {
    await assert.rejects(
      enterOrderBranch(cwd, { id: 'a1b2c3d4-0000-4000-8000-000000000001', title: 'Test' }, null, statusFails),
      (error: unknown) => error instanceof OrderBranchError && /git status/.test(error.message),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('orderWorkInProgress: scheitert git status auf einem Auftrags-Branch, wird der Fehler durchgereicht', async () => {
  const cwd = repository();
  try {
    execFileSync('git', ['checkout', '-q', '-b', 'auftrag/test'], { cwd, stdio: 'ignore' });
    await assert.rejects(orderWorkInProgress(cwd, statusFails), OrderBranchError);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('foreignChanges: unversioniertes .claude/ (Worktrees der Agent-CLI) zählt nicht als fremde Änderung', async () => {
  const cwd = repository();
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
      .toString()
      .trim();
  try {
    // Wie die Claude-CLI eines Reviewers: Worktree samt Branch unter .claude/worktrees/, gesperrt.
    const worktree = join(cwd, '.claude', 'worktrees', 'agent-a1b2c3');
    git('worktree', 'add', '-q', '-b', 'worktree-agent-a1b2c3', worktree, 'main');
    git('worktree', 'lock', worktree);
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{}\n');
    const branch = await enterOrderBranch(cwd, { id: 'a1b2c3d4-0000-4000-8000-000000000002', title: 'Doku' }, null);
    assert.equal(branch?.branch, 'auftrag/a1b2c3d4-doku', 'der Auftrag startet trotz .claude/');
    // Versionierte Dateien unter .claude/ zählen weiter: eine geänderte Einstellung ist fremd.
    git('checkout', '-q', 'main');
    writeFileSync(join(cwd, '.claude', 'settings.json'), '{"a":1}\n');
    git('add', '.claude/settings.json');
    git('commit', '-q', '-m', 'Einstellungen');
    writeFileSync(join(cwd, '.claude', 'settings.json'), '{"a":2}\n');
    await assert.rejects(
      enterOrderBranch(cwd, { id: 'a1b2c3d4-0000-4000-8000-000000000003', title: 'Zwei' }, null),
      (error: unknown) => error instanceof OrderBranchError && /\.claude\/settings\.json/.test(error.message),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('removeAgentWorktrees: entfernt Worktrees unter .claude/worktrees samt Sperre und CLI-Branch, prunt und löscht den Ordner', async () => {
  const cwd = repository();
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
      .toString()
      .trim();
  try {
    const worktree = join(cwd, '.claude', 'worktrees', 'agent-x1');
    git('worktree', 'add', '-q', '-b', 'worktree-agent-x1', worktree, 'main');
    git('worktree', 'lock', worktree);
    // Ein Worktree mit eigenen Commits: der Worktree geht, sein Branch bleibt (Arbeit eines Agents).
    const busy = join(cwd, '.claude', 'worktrees', 'agent-x2');
    git('worktree', 'add', '-q', '-b', 'worktree-agent-x2', busy, 'main');
    writeFileSync(join(busy, 'neu.txt'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: busy });
    execFileSync('git', ['-c', 'user.email=t@e.c', '-c', 'user.name=T', 'commit', '-q', '-m', 'Arbeit'], { cwd: busy });
    // Ein Worktree der Menschen ausserhalb bleibt unberührt.
    const human = mkdtempSync(join(tmpdir(), 'dev-log-human-'));
    rmSync(human, { recursive: true, force: true });
    git('worktree', 'add', '-q', '-b', 'mensch', human, 'main');
    try {
      const removed = await removeAgentWorktrees(cwd);
      assert.deepEqual(removed.map((path) => path.split('/').at(-1)).sort(), ['agent-x1', 'agent-x2']);
      const branches = git('branch', '--format=%(refname:short)').split('\n');
      assert.ok(!branches.includes('worktree-agent-x1'), 'leerer CLI-Branch gelöscht');
      assert.ok(branches.includes('worktree-agent-x2'), 'Branch mit eigenen Commits bleibt');
      assert.ok(branches.includes('mensch'));
      assert.match(git('worktree', 'list'), /mensch/);
      assert.doesNotMatch(git('worktree', 'list'), /agent-x/);
      assert.ok(!existsSync(join(cwd, '.claude', 'worktrees')), '.claude/worktrees entfernt');
      assert.deepEqual(await removeAgentWorktrees(cwd), [], 'zweiter Lauf findet nichts');
    } finally {
      rmSync(human, { recursive: true, force: true });
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
