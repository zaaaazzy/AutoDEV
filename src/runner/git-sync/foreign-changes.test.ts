import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { type CommandExecutor, runCommand } from '../../core/command.js';
import { enterOrderBranch, OrderBranchError, orderWorkInProgress } from './order-branch.js';

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
