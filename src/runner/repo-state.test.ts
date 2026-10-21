import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCommand } from '../core/command.js';
import { assessFolder, type FolderSnapshot, readFolder } from './repo-state.js';

const snapshot = (overrides: Partial<FolderSnapshot> = {}): FolderSnapshot => ({
  folder: '/projekt',
  role: 'live',
  branch: 'main',
  repository: true,
  changed: [],
  changedCount: 0,
  untracked: [],
  untrackedCount: 0,
  mainAhead: 0,
  mainBehind: 0,
  ...overrides,
});
const idle = { agentsWorkHere: false, agentRunning: false };
const codes = (problems: { code: string; severity: string }[]) =>
  problems.map((problem) => `${problem.code}:${problem.severity}`);

test('Projektordner sauber auf main: keine Befunde', () => {
  assert.deepEqual(assessFolder(snapshot(), idle), []);
});

test('Fremder Branch mit offenen Änderungen im Projektordner sperrt und bietet „Zwischenstand sichern“ an', () => {
  const problems = assessFolder(
    snapshot({
      branch: 'feat/kopf-suche',
      changed: ['src/a.ts', 'src/b.ts'],
      changedCount: 2,
      untracked: ['neu.ts'],
      untrackedCount: 1,
    }),
    idle,
  );
  assert.deepEqual(codes(problems), ['foreign_branch:block', 'uncommitted:block', 'untracked:warn']);
  assert.deepEqual(problems[0]?.fixes, ['save_wip']);
  assert.match(problems[1]?.detail ?? '', /src\/a\.ts, src\/b\.ts/);
});

test('Fremder Branch ohne Änderungen: zurück auf main anbieten', () => {
  const problems = assessFolder(snapshot({ branch: 'feat/x' }), idle);
  assert.deepEqual(
    problems.map((problem) => problem.fixes),
    [['checkout_main']],
  );
});

test('Projektordner, in dem die Agents arbeiten: Sprint- und Auftrags-Branch sind normal, offene Änderungen während eines Laufs auch', () => {
  const busy = { agentsWorkHere: true, agentRunning: true };
  assert.deepEqual(
    assessFolder(snapshot({ branch: 'sprint/sprint-9', changedCount: 3, changed: ['a', 'b', 'c'] }), busy),
    [],
  );
  assert.deepEqual(
    codes(
      assessFolder(snapshot({ branch: 'auftrag/abc', changedCount: 1, changed: ['a'] }), {
        agentsWorkHere: true,
        agentRunning: false,
      }),
    ),
    ['uncommitted:block'],
  );
});

test('Eigener Projektordner neben dem Agent-Arbeitsordner muss auf main stehen', () => {
  assert.deepEqual(codes(assessFolder(snapshot({ branch: 'sprint/sprint-9' }), idle)), ['foreign_branch:block']);
});

test('main gegenüber GitHub: abweichend sperrt, voraus oder zurück warnt', () => {
  assert.deepEqual(codes(assessFolder(snapshot({ mainAhead: 2, mainBehind: 1 }), idle)), ['main_diverged:block']);
  assert.deepEqual(codes(assessFolder(snapshot({ mainAhead: 2 }), idle)), ['main_ahead:warn']);
  assert.deepEqual(codes(assessFolder(snapshot({ mainBehind: 4 }), idle)), ['main_behind:warn']);
  // Der Abstand zu GitHub zählt nur einmal, am Projektordner.
  assert.deepEqual(
    assessFolder(snapshot({ role: 'agents', branch: 'sprint/sprint-9', mainAhead: 2, mainBehind: 1 }), idle),
    [],
  );
});

test('Losgelöster Stand (Vorschau, Agent-Worktree) ist normal, offene Änderungen dort aber nicht', () => {
  assert.deepEqual(assessFolder(snapshot({ branch: null }), idle), []);
  assert.deepEqual(codes(assessFolder(snapshot({ branch: null, changedCount: 1, changed: ['a'] }), idle)), [
    'uncommitted:block',
  ]);
});

test('readFolder liest Branch, Änderungen und den Abstand zu origin/main aus einem echten Repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repo-state-'));
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  const git = async (cwd: string, ...args: string[]) => {
    const result = await runCommand(['git', ...args], cwd, {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
    assert.equal(result.exitCode, 0, result.output);
  };
  await git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  await git(root, 'clone', '-q', remote, work);
  await writeFile(join(work, 'a.txt'), 'a\n');
  await git(work, 'add', '.');
  await git(work, 'commit', '-q', '-m', 'eins');
  await git(work, 'push', '-q', 'origin', 'main');
  await writeFile(join(work, 'b.txt'), 'b\n');
  await git(work, 'add', '.');
  await git(work, 'commit', '-q', '-m', 'zwei');
  await git(work, 'switch', '-q', '-c', 'feat/test');
  await writeFile(join(work, 'a.txt'), 'geändert\n');
  await writeFile(join(work, 'neu.txt'), 'neu\n');
  const state = await readFolder(work, 'live');
  assert.equal(state.branch, 'feat/test');
  assert.deepEqual(state.changed, ['a.txt']);
  assert.deepEqual(state.untracked, ['neu.txt']);
  assert.equal(state.mainAhead, 1);
  assert.equal(state.mainBehind, 0);
});
