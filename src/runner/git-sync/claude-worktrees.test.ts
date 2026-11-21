// Worktrees und Dateien der Claude-CLI unter .claude/ im Arbeitsordner: nie „fremde Änderung“, Worktrees werden entfernt.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCommand } from '../../core/command.js';
import {
  CLAUDE_LOCAL_DIRECTORY,
  gitHelpers,
  nestedClaudeWorktree,
  removeNestedClaudeWorktrees,
  untrackedClaudeEntry,
} from './git-helpers.js';
import { enterOrderBranch, OrderBranchError } from './order-branch.js';

const item = { id: 'a1b2c3d4-0000-4000-8000-000000000002', title: 'Claude-Worktrees' };

function repository(): { cwd: string; git: (...args: string[]) => string } {
  const cwd = mkdtempSync(join(tmpdir(), 'claude-worktrees-'));
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
      .toString()
      .trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(cwd, 'README.md'), 'Start\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Start');
  return { cwd, git };
}

test('untrackedClaudeEntry: nur unversionierte Einträge unter .claude/', () => {
  assert.ok(untrackedClaudeEntry('?? .claude/worktrees/review/'));
  assert.ok(untrackedClaudeEntry('?? .claude/settings.local.json'));
  // Versionierte Einstellungen, die jemand änderte, bleiben eine fremde Änderung.
  assert.equal(untrackedClaudeEntry(' M .claude/settings.json'), false);
  assert.equal(untrackedClaudeEntry('M .claude/settings.json'), false);
  assert.equal(untrackedClaudeEntry('?? .claude-flow/x'), false);
  assert.equal(untrackedClaudeEntry('?? src/.claude/x'), false);
});

test('nestedClaudeWorktree: nur Pfade unter .claude/worktrees/ des Arbeitsordners', () => {
  const cwd = '/projekt/agent';
  assert.ok(nestedClaudeWorktree(cwd, '/projekt/agent/.claude/worktrees/review'));
  assert.ok(nestedClaudeWorktree(cwd, '/projekt/agent/.claude/worktrees/a/b'));
  assert.equal(nestedClaudeWorktree(cwd, '/projekt/agent/.claude/worktrees/'), false);
  assert.equal(nestedClaudeWorktree(cwd, '/projekt/agent/.claude/worktrees'), false);
  assert.equal(nestedClaudeWorktree(cwd, '/projekt/agent/.claude/other'), false);
  assert.equal(nestedClaudeWorktree(cwd, '/projekt/agent/.claude-worktrees/x'), false);
  assert.equal(nestedClaudeWorktree(cwd, '/projekt/agent'), false);
  assert.equal(nestedClaudeWorktree(cwd, '/projekt/source'), false);
  assert.equal(nestedClaudeWorktree(cwd, '/projekt/source/.claude/worktrees/x'), false);
  assert.equal(nestedClaudeWorktree(cwd, '/projekt/agent/../source/.claude/worktrees/x'), false);
});

test('enterOrderBranch: unversionierte Dateien unter .claude/ sind keine fremde Änderung', async () => {
  const { cwd, git } = repository();
  try {
    mkdirSync(join(cwd, '.claude', 'worktrees', 'rest'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'worktrees', 'rest', 'notiz.md'), 'x\n');
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{}\n');
    const branch = await enterOrderBranch(cwd, item, null);
    assert.ok(branch);
    assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), branch.branch);
    // .claude/ steht lokal ausgeschlossen – idempotent, auch nach dem zweiten Auftrag nur einmal.
    git('checkout', '-q', 'main');
    await enterOrderBranch(cwd, { ...item, title: 'Noch einmal' }, null);
    const exclude = readFileSync(join(cwd, '.git', 'info', 'exclude'), 'utf8').split('\n');
    assert.equal(exclude.filter((line) => line === CLAUDE_LOCAL_DIRECTORY).length, 1);
    // Eine echte fremde Datei hält den Auftrag weiterhin auf.
    git('checkout', '-q', 'main');
    writeFileSync(join(cwd, 'fremd.txt'), 'x\n');
    await assert.rejects(enterOrderBranch(cwd, { ...item, title: 'Dritter' }, null), OrderBranchError);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('enterOrderBranch: ein Worktree der Claude-CLI unter .claude/worktrees/ wird entfernt, andere nicht', async () => {
  const { cwd, git } = repository();
  const neighbour = `${cwd}-nachbar`;
  try {
    git('worktree', 'add', '-q', join(cwd, '.claude', 'worktrees', 'review'), '-b', 'review-probe');
    writeFileSync(join(cwd, '.claude', 'worktrees', 'review', 'offen.txt'), 'nicht committet\n');
    git('worktree', 'add', '-q', '--detach', neighbour, 'main');
    const branch = await enterOrderBranch(cwd, item, null);
    assert.ok(branch);
    assert.equal(existsSync(join(cwd, '.claude', 'worktrees', 'review')), false);
    const listing = git('worktree', 'list', '--porcelain');
    assert.equal(listing.includes('.claude/worktrees/review'), false);
    assert.ok(listing.includes(`-nachbar`));
    assert.ok(existsSync(join(neighbour, 'README.md')));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(neighbour, { recursive: true, force: true });
  }
});

test('removeNestedClaudeWorktrees: liefert die entfernten Pfade, nichts ohne Treffer', async () => {
  const { cwd, git } = repository();
  try {
    const { git: helper } = gitHelpers(runCommand, cwd);
    assert.deepEqual(await removeNestedClaudeWorktrees(helper, cwd), []);
    const nested = join(cwd, '.claude', 'worktrees', 'probe');
    git('worktree', 'add', '-q', nested, '-b', 'probe');
    const removed = await removeNestedClaudeWorktrees(helper, cwd);
    assert.equal(removed.length, 1);
    assert.ok(removed[0]?.endsWith(join('.claude', 'worktrees', 'probe')));
    assert.equal(existsSync(nested), false);
    // Der Branch des entfernten Worktrees bleibt erhalten, nur der Ordner und der Eintrag sind weg.
    assert.equal(git('rev-parse', '--verify', '--quiet', 'refs/heads/probe').length > 0, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
