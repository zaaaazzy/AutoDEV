import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCommand } from '../core/command.js';
import { applyGitFix } from './repo-fix.js';
import { readFolder } from './repo-state.js';

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};
async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand(['git', ...args], cwd, { env });
  assert.equal(result.exitCode, 0, `git ${args.join(' ')}: ${result.output}`);
  return result.output.trim();
}
async function commit(cwd: string, file: string, content: string, message: string): Promise<void> {
  await writeFile(join(cwd, file), content);
  await git(cwd, 'add', file);
  await git(cwd, 'commit', '-q', '-m', message);
}

/** Remote („GitHub“) und ein Klon mit einem gemeinsamen ersten Commit auf main. */
async function setup(): Promise<{ root: string; remote: string; work: string }> {
  const root = await mkdtemp(join(tmpdir(), 'repo-fix-'));
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  await git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  await git(root, 'clone', '-q', remote, work);
  await commit(work, 'a.txt', 'a\n', 'eins');
  await git(work, 'push', '-q', 'origin', 'main');
  return { root, remote, work };
}

test('Zwischenstand auf fremdem Branch: alles committen, Zugangsdaten bleiben draussen', async () => {
  const { work } = await setup();
  await git(work, 'switch', '-q', '-c', 'feat/kopf');
  await writeFile(join(work, 'a.txt'), 'geändert\n');
  await writeFile(join(work, 'neu.ts'), 'export {};\n');
  await writeFile(join(work, 'geheim.txt'), 'API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz0123456789\n');
  const message = await applyGitFix('save_wip', work);
  assert.match(message, /2 Dateien auf feat\/kopf gesichert/);
  assert.match(message, /nach Zugangsdaten aussehen: geheim\.txt/);
  const state = await readFolder(work, 'live');
  assert.equal(state.branch, 'feat/kopf');
  assert.equal(state.changedCount, 0);
  assert.deepEqual(state.untracked, ['geheim.txt']);
});

test('Zwischenstand auf main: neuer Branch wip/…, main bleibt sauber und ausgecheckt', async () => {
  const { work } = await setup();
  await writeFile(join(work, 'a.txt'), 'auf main geändert\n');
  const message = await applyGitFix('save_wip', work, runCommand, new Date('2026-10-21T20:15:00Z'));
  assert.match(message, /auf wip\/20261021-2015 gesichert/);
  assert.equal(await git(work, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(await readFile(join(work, 'a.txt'), 'utf8'), 'a\n');
  assert.equal(await git(work, 'show', 'wip/20261021-2015:a.txt'), 'auf main geändert');
});

test('Zurück auf main nur ohne offene Änderungen', async () => {
  const { work } = await setup();
  await git(work, 'switch', '-q', '-c', 'feat/x');
  await writeFile(join(work, 'a.txt'), 'offen\n');
  await assert.rejects(applyGitFix('checkout_main', work), /zuerst „Zwischenstand sichern“/);
  await git(work, 'checkout', '--', 'a.txt');
  assert.match(await applyGitFix('checkout_main', work), /Von feat\/x auf main gewechselt/);
  assert.equal(await git(work, 'symbolic-ref', '--short', 'HEAD'), 'main');
});

test('main abgleichen: abweichende Stände werden zusammengeführt und gepusht, ohne Force-Push', async () => {
  const { root, remote, work } = await setup();
  // Jemand anderes pusht nach GitHub, lokal entsteht ein eigener Commit auf main (nicht ausgecheckt).
  const other = join(root, 'other');
  await git(root, 'clone', '-q', remote, other);
  await commit(other, 'b.txt', 'b\n', 'von GitHub');
  await git(other, 'push', '-q', 'origin', 'main');
  await commit(work, 'c.txt', 'c\n', 'lokal');
  await git(work, 'switch', '-q', '-c', 'feat/arbeit');
  await git(work, 'fetch', '-q', 'origin');
  const before = await readFolder(work, 'live');
  assert.deepEqual([before.mainAhead, before.mainBehind], [1, 1]);
  const message = await applyGitFix('sync_main', work);
  assert.match(message, /1 Commit von GitHub übernommen/);
  assert.match(message, /nach GitHub gepusht/);
  const after = await readFolder(work, 'live');
  assert.deepEqual([after.mainAhead, after.mainBehind], [0, 0]);
  assert.equal(after.branch, 'feat/arbeit');
  // Beide Commits sind auf GitHub, der Hilfs-Worktree ist wieder weg.
  const log = await git(remote, 'log', '--format=%s', 'main');
  assert.match(log, /von GitHub/);
  assert.match(log, /lokal/);
  assert.doesNotMatch(await git(work, 'worktree', 'list'), /aideation-main-/);
});

test('main abgleichen im ausgecheckten main: nur zurück → Fast-Forward', async () => {
  const { root, remote, work } = await setup();
  const other = join(root, 'other');
  await git(root, 'clone', '-q', remote, other);
  await commit(other, 'b.txt', 'b\n', 'von GitHub');
  await git(other, 'push', '-q', 'origin', 'main');
  assert.match(await applyGitFix('sync_main', work), /1 Commit von GitHub übernommen/);
  assert.equal(await readFile(join(work, 'b.txt'), 'utf8'), 'b\n');
});

test('main abgleichen: Konflikt bricht ab und meldet es', async () => {
  const { root, remote, work } = await setup();
  const other = join(root, 'other');
  await git(root, 'clone', '-q', remote, other);
  await commit(other, 'a.txt', 'GitHub\n', 'konflikt drüben');
  await git(other, 'push', '-q', 'origin', 'main');
  await commit(work, 'a.txt', 'lokal\n', 'konflikt hier');
  await assert.rejects(applyGitFix('sync_main', work), /Konflikt beim Zusammenführen/);
  assert.equal(await git(work, 'status', '--porcelain', '--untracked-files=no'), '');
});
