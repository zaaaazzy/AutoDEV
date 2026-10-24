import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, open, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import { briefGitError, gitHelpers } from './git-helpers.js';
import { reconcileWorkingTree } from './reconcile.js';
import { clearStaleIndexLock } from './stale-lock.js';
import { runCommand } from '../../core/command.js';

const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;

/** Menschen-Ordner auf main und losgelöster Agent-Worktree (wie bei AIdeation selbst). */
async function setup(): Promise<{ human: string; agents: string; git: (cwd: string, ...args: string[]) => string }> {
  const root = await mkdtemp(join(tmpdir(), 'reconcile-'));
  const human = join(root, 'source');
  const agents = join(root, 'agents');
  const git = (cwd: string, ...args: string[]) =>
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
  execFileSync('mkdir', ['-p', human]);
  git(human, 'init', '-q', '-b', 'main');
  await writeFile(join(human, 'a.txt'), 'a\n');
  git(human, 'add', '-A');
  git(human, 'commit', '-q', '-m', 'eins');
  git(human, 'worktree', 'add', '-q', '--detach', agents, 'main');
  return { human, agents, git };
}

test('Neustart: unterbrochener Auftrag bekommt WIP-Commit auf seinem Branch, Ordner zurück auf main (losgelöst)', async () => {
  const { human, agents, git } = await setup();
  git(agents, 'switch', '-q', '-c', 'auftrag/1a2b3c4d-login');
  await writeFile(join(agents, 'a.txt'), 'halb fertig\n');
  const result = await reconcileWorkingTree(pool, 'p', human, agents);
  assert.ok(result.actions.some((action) => action.includes('auftrag/1a2b3c4d-login gesichert')));
  assert.equal(git(agents, 'status', '--porcelain'), '');
  assert.equal(git(agents, 'rev-parse', 'HEAD'), git(human, 'rev-parse', 'main'));
  assert.equal(git(agents, 'show', 'auftrag/1a2b3c4d-login:a.txt'), 'halb fertig');
});

test('Neustart: lose Dateien auf dem Basis-Stand werden auf wip/neustart-… geparkt, nichts geht verloren', async () => {
  const { human, agents, git } = await setup();
  const start = git(agents, 'rev-parse', 'HEAD');
  await writeFile(join(agents, 'a.txt'), 'lose Kopie\n');
  await writeFile(join(agents, 'neu.ts'), 'export {};\n');
  const result = await reconcileWorkingTree(pool, 'p', human, agents, undefined, new Date('2026-10-22T17:08:00Z'));
  assert.ok(result.actions.some((action) => action.includes('wip/neustart-20261022-1708')));
  assert.equal(git(agents, 'status', '--porcelain'), '');
  assert.equal(git(agents, 'rev-parse', 'HEAD'), start);
  assert.equal(git(agents, 'show', 'wip/neustart-20261022-1708:neu.ts'), 'export {};');
});

test('Neustart: halber Merge wird abgebrochen; Ordner der Menschen bleibt unangetastet', async () => {
  const { human, agents, git } = await setup();
  git(agents, 'switch', '-q', '-c', 'sprint/s1');
  await writeFile(join(agents, 'a.txt'), 'sprint\n');
  git(agents, 'commit', '-q', '-am', 'sprint');
  await writeFile(join(human, 'a.txt'), 'main\n');
  git(human, 'commit', '-q', '-am', 'main');
  assert.throws(() => git(agents, 'merge', 'main'));
  await writeFile(join(human, 'mensch.txt'), 'meine Arbeit\n');
  const result = await reconcileWorkingTree(pool, 'p', human, agents);
  assert.ok(result.actions.includes('Halben Merge abgebrochen.'));
  assert.equal(git(agents, 'status', '--porcelain'), '');
  assert.equal(git(human, 'status', '--porcelain'), '?? mensch.txt');
});

test('Neustart ohne eigenen Agent-Ordner: offene Änderungen im gemeinsamen Ordner bleiben stehen', async () => {
  const { human, git } = await setup();
  await writeFile(join(human, 'a.txt'), 'Mensch arbeitet\n');
  const result = await reconcileWorkingTree(pool, 'p', human, human);
  assert.deepEqual(result.actions, []);
  assert.equal(git(human, 'status', '--porcelain'), 'M a.txt');
});

test('Verwaiste index.lock: wird erkannt, umbenannt, und git arbeitet wieder (auch über gitHelpers)', async () => {
  const { agents, git } = await setup();
  const gitDir = git(agents, 'rev-parse', '--absolute-git-dir');
  const lock = join(gitDir, 'index.lock');
  await writeFile(lock, '');
  const old = new Date(Date.now() - 5 * 60_000);
  await utimes(lock, old, old);
  await writeFile(join(agents, 'b.txt'), 'b\n');
  const { git: helperGit } = gitHelpers(runCommand, agents);
  const added = await helperGit('add', 'b.txt');
  assert.equal(added.exitCode, 0, added.output);
  assert.equal(existsSync(lock), false);
  assert.ok((await readdir(gitDir)).some((name) => name.startsWith('index.lock.stale-')));
});

test('index.lock in Benutzung oder ganz frisch: bleibt liegen', async () => {
  const { agents, git } = await setup();
  const lock = join(git(agents, 'rev-parse', '--absolute-git-dir'), 'index.lock');
  await writeFile(lock, '');
  assert.equal(await clearStaleIndexLock(agents), null, 'frisch angelegt');
  const handle = await open(lock, 'r');
  try {
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(lock, old, old);
    if (process.platform !== 'win32')
      assert.equal(await clearStaleIndexLock(agents), null, 'von einem Prozess gehalten');
  } finally {
    await handle.close();
  }
  assert.ok(existsSync(lock));
});

test('index.lock kurz von einem anderen Prozess gehalten: git wartet und schafft es danach', async () => {
  const { agents, git } = await setup();
  const lock = join(git(agents, 'rev-parse', '--absolute-git-dir'), 'index.lock');
  await writeFile(join(agents, 'c.txt'), 'c\n');
  // Wie ein `git status` von Editor oder App: Sperre angelegt und offen gehalten, nach kurzer Zeit wieder frei.
  await writeFile(lock, '');
  const handle = await open(lock, 'r');
  setTimeout(() => {
    void handle.close().then(() => rm(lock, { force: true }));
  }, 400);
  const { git: helperGit } = gitHelpers(runCommand, agents);
  const added = await helperGit('add', 'c.txt');
  assert.equal(added.exitCode, 0, added.output);
  assert.equal(git(agents, 'diff', '--cached', '--name-only'), 'c.txt');
});

test('Git-Fehler gekürzt: Ursache am Anfang und Ergebnis am Ende bleiben erhalten', () => {
  const output = `fatal: Unable to create '/repo/.git/index.lock': File exists.\n${'x'.repeat(600)}\nMerge with strategy ort failed.`;
  const brief = briefGitError(output);
  assert.ok(brief.length <= 303);
  assert.match(brief, /index\.lock/);
  assert.match(brief, /strategy ort failed\.$/);
  assert.equal(briefGitError('kurz'), 'kurz');
});
