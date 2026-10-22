import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gitHelpers, mergeSources } from './git-helpers.js';
import { clearStaleLocks, lockedFile } from './stale-lock.js';
import { runCommand } from '../../core/command.js';

/** Menschen-Ordner auf main, Agent-Worktree auf sprint/s1; auftrag/x bringt eine neue Datei b.txt mit. */
async function setup(): Promise<{ human: string; agents: string; git: (cwd: string, ...args: string[]) => string }> {
  const root = await mkdtemp(join(tmpdir(), 'stale-lock-'));
  const human = join(root, 'source');
  const agents = join(root, 'agents');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      stdio: 'pipe',
      env: {
        ...process.env,
        LANG: 'C',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    })
      .toString()
      .trim();
  await mkdir(human, { recursive: true });
  git(human, 'init', '-q', '-b', 'main');
  await writeFile(join(human, 'a.txt'), 'a\n');
  git(human, 'add', '-A');
  git(human, 'commit', '-q', '-m', 'eins');
  git(human, 'worktree', 'add', '-q', '-b', 'sprint/s1', agents, 'main');
  git(agents, 'switch', '-q', '-c', 'auftrag/x');
  await writeFile(join(agents, 'b.txt'), 'b\n');
  git(agents, 'add', '-A');
  git(agents, 'commit', '-q', '-m', 'auftrag');
  git(agents, 'switch', '-q', 'sprint/s1');
  // Eigener Commit auf dem Sprint, damit der Merge mit --no-ff wirklich ort braucht (kein reiner Vorlauf).
  await writeFile(join(agents, 'c.txt'), 'c\n');
  git(agents, 'add', '-A');
  git(agents, 'commit', '-q', '-m', 'sprint');
  return { human, agents, git };
}

const aged = async (file: string) => {
  const old = new Date(Date.now() - 5 * 60_000);
  await utimes(file, old, old);
};

test('Sperrdatei aus der Fehlermeldung von git (englisch und deutsch)', () => {
  assert.equal(
    lockedFile(
      "error: update_ref failed for ref 'AUTO_MERGE': cannot lock ref 'AUTO_MERGE': Unable to create '/r/.git/worktrees/a/AUTO_MERGE.lock': File exists.",
    ),
    '/r/.git/worktrees/a/AUTO_MERGE.lock',
  );
  assert.equal(lockedFile("fatal: Konnte '/r/.git/index.lock' nicht erstellen: File exists."), '/r/.git/index.lock');
  assert.equal(lockedFile('CONFLICT (content): Merge conflict in a.txt'), null);
});

test('Quellen eines Merges: ohne Optionen und ohne die Nachricht nach -m', () => {
  assert.deepEqual(mergeSources(['merge', '--no-ff', 'auftrag/x', '-m', 'Merge auftrag/x']), ['auftrag/x']);
  assert.deepEqual(mergeSources(['merge', '--no-edit', 'main', '-m', 'm']), ['main']);
  assert.deepEqual(mergeSources(['merge', '--abort']), []);
});

test('Verwaiste AUTO_MERGE.lock (Sprint 20): Merge über gitHelpers gelingt, keine Reste im Ordner', async () => {
  const { agents, git } = await setup();
  const lock = join(git(agents, 'rev-parse', '--absolute-git-dir'), 'AUTO_MERGE.lock');
  await writeFile(lock, '');
  await aged(lock);
  const merged = await gitHelpers(runCommand, agents).git('merge', '--no-ff', 'auftrag/x', '-m', 'Merge auftrag/x');
  assert.equal(merged.exitCode, 0, merged.output);
  assert.equal(existsSync(lock), false);
  assert.equal(git(agents, 'status', '--porcelain'), '');
  assert.equal(git(agents, 'show', 'HEAD:b.txt'), 'b');
});

test('AUTO_MERGE.lock von einem Prozess gehalten: Merge scheitert, lässt aber keine unversionierten Dateien liegen', async (t) => {
  if (process.platform === 'win32') return t.skip('ohne lsof gilt die Sperre erst nach 10 Minuten als verwaist');
  const { agents, git } = await setup();
  const lock = join(git(agents, 'rev-parse', '--absolute-git-dir'), 'AUTO_MERGE.lock');
  await writeFile(lock, '');
  await aged(lock);
  const handle = await open(lock, 'r');
  try {
    const merged = await gitHelpers(runCommand, agents).git('merge', '--no-ff', 'auftrag/x', '-m', 'Merge');
    assert.notEqual(merged.exitCode, 0);
    assert.ok(lockedFile(merged.output), merged.output);
  } finally {
    await handle.close();
  }
  assert.ok(existsSync(lock), 'gehaltene Sperre bleibt liegen');
  assert.equal(git(agents, 'status', '--porcelain'), '', 'b.txt aus dem halben Merge ist wieder weg');
});

test('Start des Workers: Sperren des Agent-Ordners und verwaiste Ref-Sperren weg, Ordner der Menschen unangetastet', async () => {
  const { human, agents, git } = await setup();
  const agentDir = git(agents, 'rev-parse', '--absolute-git-dir');
  const commonDir = git(human, 'rev-parse', '--absolute-git-dir');
  const autoMerge = join(agentDir, 'AUTO_MERGE.lock');
  const humanIndex = join(commonDir, 'index.lock');
  const oldRef = join(commonDir, 'refs', 'heads', 'sprint', 's1.lock');
  const freshRef = join(commonDir, 'refs', 'heads', 'main.lock');
  for (const file of [autoMerge, humanIndex, oldRef, freshRef]) await writeFile(file, '');
  await aged(oldRef);
  await aged(humanIndex);
  const actions = await clearStaleLocks(agents, Date.now(), { minAgeMs: 0 });
  assert.equal(actions.length, 2, actions.join('\n'));
  assert.equal(existsSync(autoMerge), false, 'frisch, aber im eigenen Git-Verzeichnis beim Start verwaist');
  assert.equal(existsSync(oldRef), false, 'alte Ref-Sperre');
  assert.ok(existsSync(freshRef), 'frische Ref-Sperre kann einem anderen Worktree gehören');
  assert.ok(existsSync(humanIndex), 'Index der Menschen wird nie angefasst');
});
