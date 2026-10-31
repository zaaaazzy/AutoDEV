import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { gitHelpers } from '../runner/git-sync/git-helpers.js';
import { gitEnvironment } from '../runner/project-command.js';
import { runCommand } from './command.js';
import { gitSubcommand, unsafeConfigEntry } from './git-guard.js';

const PLAIN_ENV = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

/** Repository mit einem Commit; `git` ohne Prüfung (wie ein Agent im Container). */
async function repository(): Promise<{ dir: string; plain: (...args: string[]) => string }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'git-guard-')));
  const plain = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      env: {
        ...PLAIN_ENV,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@x',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@x',
      },
      stdio: 'pipe',
    })
      .toString()
      .trim();
  plain('init', '-q', '-b', 'main');
  await writeFile(join(dir, 'a.txt'), 'a\n');
  plain('add', '-A');
  plain('commit', '-q', '-m', 'Start');
  return { dir, plain };
}

/** Konfiguration, deren Filter beim nächsten `git add` eine Marker-Datei schreibt. */
async function plantFilter(configDir: string, workTree: string, marker: string): Promise<void> {
  execFileSync('git', [
    'config',
    '--file',
    join(configDir, 'config'),
    'filter.x.clean',
    `sh -c 'touch ${marker}; cat'`,
  ]);
  await writeFile(join(workTree, '.gitattributes'), '* filter=x\n');
  await writeFile(join(workTree, 'b.txt'), 'b\n');
}

test('unsafeConfigEntry lässt übliche Einträge durch und weist ausführbare ab', () => {
  for (const [key, value] of [
    ['core.repositoryformatversion', '0'],
    ['core.hookspath', '.husky'],
    ['remote.origin.url', 'git@github.com:zaaaazzy/AutoDEV.git'],
    ['remote.origin.url', 'https://github.com/zaaaazzy/AutoDEV.git'],
    ['remote.origin.url', '/tmp/remote.git'],
    ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
    ['branch.fix/x.vscode-merge-base', 'origin/main'],
    ['user.email', 'bot@example.com'],
    ['filter.lfs.process', 'git-lfs filter-process'],
  ]) {
    assert.equal(unsafeConfigEntry(key, value), null, key);
  }
  for (const [key, value] of [
    ['filter.x.clean', 'sh -c id'],
    ['filter.lfs.process', 'sh -c id'],
    ['credential.helper', '!sh -c id'],
    ['core.sshcommand', 'sh -c id'],
    ['core.pager', 'sh -c id'],
    ['core.worktree', '/'],
    ['gpg.program', 'sh'],
    ['diff.x.textconv', 'sh'],
    ['merge.x.driver', 'sh'],
    ['include.path', '/tmp/x'],
    ['includeif.gitdir:/.path', '/tmp/x'],
    ['remote.origin.uploadpack', 'sh'],
    ['remote.origin.url', 'ext::sh -c id'],
    ['url.https://evil/.insteadof', 'https://github.com/'],
  ]) {
    assert.notEqual(unsafeConfigEntry(key, value), null, key);
  }
});

test('gitSubcommand überspringt vorangestellte Optionen', () => {
  assert.equal(gitSubcommand(['-c', 'core.quotePath=false', 'diff', '--cached']), 'diff');
  assert.equal(gitSubcommand(['--no-pager', 'log']), 'log');
  assert.equal(gitSubcommand(['init', '-b', 'main']), 'init');
});

test('Filter aus .git/config läuft beim git add des Workers nicht – Gegenprobe ohne Prüfung führt ihn aus', async () => {
  const { dir, plain } = await repository();
  const marker = `${dir}-filter-ran`;
  await plantFilter(join(dir, '.git'), dir, marker);
  const { git } = gitHelpers(runCommand, dir);
  const result = await git('add', '-A');
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /filter\.x\.clean/);
  assert.equal(existsSync(marker), false, 'Der Filter des Agents wurde ausgeführt');
  plain('add', '-A');
  assert.equal(existsSync(marker), true, 'Gegenprobe: ohne Prüfung läuft der Filter');
});

test('Umgelenktes gitdir im Arbeitsordner wird abgewiesen, auch mit harmloser Konfiguration', async () => {
  const { dir } = await repository();
  // Der Agent legt ein eigenes Repo an und biegt .git darauf um (Datei im Worktree, ersetzter Ordner im Live-Checkout).
  execFileSync('cp', ['-R', join(dir, '.git'), join(dir, '.x')]);
  execFileSync('rm', ['-rf', join(dir, '.git')]);
  await writeFile(join(dir, '.git'), 'gitdir: .x\n');
  const result = await runCommand(['git', 'status', '--porcelain'], dir, { env: gitEnvironment() });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /liegt im Arbeitsordner/);
});

test('include.path und credential.helper in der Repo-Konfiguration werden abgewiesen', async () => {
  for (const [key, value] of [
    ['include.path', '/tmp/irgendwo'],
    ['credential.helper', '!sh -c "cat ~/.ssh/id_ed25519"'],
  ]) {
    const { dir, plain } = await repository();
    plain('config', key, value);
    const result = await runCommand(['git', 'push', 'origin', 'main'], dir, { env: gitEnvironment() });
    assert.notEqual(result.exitCode, 0, key);
    assert.match(result.output, new RegExp(key.replace('.', '\\.')), key);
  }
});

test('Worktree: Arbeit des Workers geht weiter, GIT_DIR zeigt auf den Haupt-Checkout', async () => {
  const { dir, plain } = await repository();
  plain('config', 'core.hooksPath', '.husky');
  plain('config', 'remote.origin.url', 'git@github.com:x/y.git');
  const tree = `${dir}-agent`;
  plain('worktree', 'add', '-q', '--detach', tree, 'main');
  await writeFile(join(tree, 'c.txt'), 'c\n');
  const { must } = gitHelpers(runCommand, tree);
  await must('checkout', '-q', '-b', 'auftrag/x');
  await must('add', '-A');
  await must('commit', '-q', '-m', 'Auftrag');
  assert.equal(plain('log', '-1', '--format=%s', 'auftrag/x'), 'Auftrag');
  const pinned = await runCommand(['git', 'rev-parse', '--absolute-git-dir'], tree, { env: gitEnvironment() });
  assert.equal(pinned.output.trim(), join(dir, '.git', 'worktrees', basename(tree)));
});

test('Ohne Repository: init läuft, andere Befehle werden abgewiesen', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'git-guard-leer-')));
  await mkdir(join(dir, 'neu'));
  const status = await runCommand(['git', 'status'], join(dir, 'neu'), {
    env: { ...gitEnvironment(), GIT_CEILING_DIRECTORIES: dir },
  });
  assert.notEqual(status.exitCode, 0);
  assert.match(status.output, /kein prüfbares Repository/);
  const init = await runCommand(['git', 'init', '-q', '-b', 'main'], join(dir, 'neu'), {
    env: { ...gitEnvironment(), GIT_CEILING_DIRECTORIES: dir },
  });
  assert.equal(init.exitCode, 0, init.output);
  assert.ok(existsSync(join(dir, 'neu', '.git')));
});
