import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('Projekt in <Projekt>/source: Agents arbeiten in <Projekt>/agent', () => {
  assert.equal(agentWorkspacePath('/Coding/Mainty/source'), '/Coding/Mainty/agent');
  assert.equal(agentWorkspacePath('/Coding/Mainty'), '/Coding/Mainty-agents');
});

test('Fremde Projektordner bleiben der Arbeitsordner der Agents', async () => {
  const folder = repository();
  assert.deepEqual(await resolveAgentWorkspace(folder, '/somewhere/else'), { cwd: folder, problem: null });
});

test('Projekt mit eigenem Arbeitsordner: Agents arbeiten im Worktree daneben', async () => {
  const folder = repository();
  const { cwd, problem } = await resolveAgentWorkspace(folder, '/somewhere/else', undefined, true);
  assert.equal(problem, null);
  assert.equal(cwd, agentWorkspacePath(folder));
  assert.ok(lstatSync(join(cwd!, 'frontend', 'node_modules')).isSymbolicLink());
  assert.equal(git(folder, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  // Auch mit `node_modules/` in .gitignore (greift nicht für Symlinks) bleiben die Links unsichtbar für git.
  writeFileSync(join(cwd!, '.gitignore'), 'node_modules/\n');
  assert.equal(git(cwd!, 'status', '--short', '--untracked-files=all'), 'M .gitignore');
});

test('npm-Workspaces: Workspace-Pakete zeigen auf den Code im Arbeitsordner, nicht in den Hauptordner', async () => {
  const folder = repository();
  mkdirSync(join(folder, 'contracts'));
  writeFileSync(join(folder, 'contracts', 'index.js'), 'haupt\n');
  mkdirSync(join(folder, 'node_modules', '@app'));
  symlinkSync('../../contracts', join(folder, 'node_modules', '@app', 'contracts'));
  mkdirSync(join(folder, 'node_modules', 'lib'));
  git(folder, 'add', '-A');
  git(folder, 'commit', '-q', '-m', 'contracts');
  // Alter Stand: node_modules als ein einziger Link.
  const workspace = agentWorkspacePath(folder);
  git(folder, 'worktree', 'add', '--detach', workspace, 'main');
  symlinkSync(join(folder, 'node_modules'), join(workspace, 'node_modules'));

  const { cwd } = await resolveAgentWorkspace(folder, '/somewhere/else', undefined, true);
  assert.equal(cwd, workspace);
  assert.ok(!lstatSync(join(workspace, 'node_modules')).isSymbolicLink());
  assert.equal(
    realpathSync(join(workspace, 'node_modules', '@app', 'contracts')),
    realpathSync(join(workspace, 'contracts')),
  );
  assert.equal(realpathSync(join(workspace, 'node_modules', 'lib')), realpathSync(join(folder, 'node_modules', 'lib')));
});

test('AIdeation-Ordner: Aufträge laufen im eigenen Worktree, der Arbeitsordner bleibt unberührt', async () => {
  const folder = repository();
  // Offene Arbeit eines Menschen im AIdeation-Ordner.
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
