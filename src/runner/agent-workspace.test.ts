import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentWorkspacePath, resolveAgentWorkspace } from './agent-workspace.js';
import { enterOrderBranch, finishOrderBranch } from './git-sync.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();

function repository(): string {
  const folder = join(mkdtempSync(join(tmpdir(), 'ws-')), 'DevLog');
  mkdirSync(join(folder, 'frontend', 'node_modules'), { recursive: true });
  mkdirSync(join(folder, 'node_modules'));
  writeFileSync(join(folder, '.gitignore'), 'node_modules\n');
  writeFileSync(join(folder, 'a.txt'), 'start\n');
  writeFileSync(join(folder, 'frontend', 'b.txt'), 'b\n');
  git(folder, 'init', '-q', '-b', 'main');
  git(folder, 'config', 'user.email', 't@t');
  git(folder, 'config', 'user.name', 't');
  git(folder, 'add', '-A');
  git(folder, 'commit', '-q', '-m', 'init');
  return folder;
}

test('Fremde Projektordner bleiben der Arbeitsordner der Agents', async () => {
  const folder = repository();
  assert.deepEqual(await resolveAgentWorkspace(folder, '/somewhere/else'), { cwd: folder, problem: null });
});

test('Dev-Log-Ordner: Aufträge laufen im eigenen Worktree, der Arbeitsordner bleibt unberührt', async () => {
  const folder = repository();
  // Offene Arbeit eines Menschen im Dev-Log-Ordner.
  writeFileSync(join(folder, 'a.txt'), 'meine offene Arbeit\n');
  const { cwd, problem } = await resolveAgentWorkspace(folder, folder);
  assert.equal(problem, null);
  assert.equal(cwd, agentWorkspacePath(folder));
  assert.ok(lstatSync(join(cwd!, 'node_modules')).isSymbolicLink());
  assert.ok(lstatSync(join(cwd!, 'frontend', 'node_modules')).isSymbolicLink());
  // Zweiter Aufruf verwendet denselben Worktree.
  assert.equal((await resolveAgentWorkspace(folder, folder)).cwd, cwd);

  const item = { id: '12345678-aaaa', title: 'Test-Auftrag' };
  const branch = await enterOrderBranch(cwd!, item, 'Sprint 1');
  assert.ok(branch);
  writeFileSync(join(cwd!, 'agent.txt'), 'vom Agent\n');
  const finished = await finishOrderBranch(cwd!, item, branch!, 'Sprint 1', false);
  assert.match(finished.message, /Zwischenstand/);

  // Der Arbeitsordner: gleicher Branch, offene Änderung weder committet noch verändert.
  assert.equal(git(folder, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(readFileSync(join(folder, 'a.txt'), 'utf8'), 'meine offene Arbeit\n');
  assert.match(git(folder, 'status', '--short'), /M a\.txt/);
  assert.equal(git(folder, 'log', '--oneline', 'main').split('\n').length, 1);
  // Der WIP-Stand des Agents liegt auf seinem Auftrags-Branch und enthält nur seine Datei.
  assert.deepEqual(git(folder, 'show', '--name-only', '--format=', branch!.branch).split('\n'), ['agent.txt']);
});
