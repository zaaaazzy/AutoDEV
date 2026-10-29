import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { type CommandExecutor, runCommand } from '../../core/command.js';
import { protectedPath } from '../../agent/path-policy.js';
import { resolveInside } from '../../agent/tool-paths.js';
import { fileProblem } from '../../agent/agent-guard.js';
import { gitHelpers } from './git-helpers.js';

const SECRET = 'geheim-schluessel-hooks';
const HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-merge-commit', 'post-merge'];

/** Repository mit Hooks in .git/hooks und .husky (per core.hooksPath aktiv), die eine Marker-Datei samt Env schreiben. */
async function repositoryWithHooks(): Promise<{ dir: string; marker: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'git-hooks-'));
  const marker = join(dir, '..', `${dir.split('/').pop()}-hook-ran`);
  const plain = (...args: string[]) =>
    runCommand(['git', ...args], dir, { env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal((await plain('init', '-q', '-b', 'main')).exitCode, 0);
  assert.equal((await plain('config', 'core.hooksPath', '.husky')).exitCode, 0);
  for (const folder of [join(dir, '.git', 'hooks'), join(dir, '.husky')]) {
    await mkdir(folder, { recursive: true });
    for (const hook of HOOKS) {
      await writeFile(join(folder, hook), `#!/bin/sh\necho "$0 $DEV_LOG_SECRET_KEY" >> "${marker}"\n`);
      await chmod(join(folder, hook), 0o755);
    }
  }
  return { dir, marker };
}

test('Hook im Projekt wird bei Commit und Merge des Workers nicht ausgeführt', async () => {
  const { dir, marker } = await repositoryWithHooks();
  const before = process.env.DEV_LOG_SECRET_KEY;
  process.env.DEV_LOG_SECRET_KEY = SECRET;
  const envs: NodeJS.ProcessEnv[] = [];
  const execute: CommandExecutor = (command, cwd, options) => {
    if (options?.env) envs.push(options.env);
    return runCommand(command, cwd, options);
  };
  try {
    const { must } = gitHelpers(execute, dir);
    await writeFile(join(dir, 'a.txt'), 'a');
    await must('add', '-A');
    await must('commit', '-q', '-m', 'Start');
    await must('checkout', '-q', '-b', 'auftrag/x');
    await writeFile(join(dir, 'b.txt'), 'b');
    await must('add', '-A');
    await must('commit', '-q', '-m', 'Auftrag');
    await must('checkout', '-q', 'main');
    await must('merge', '--no-ff', '--no-edit', 'auftrag/x', '-m', 'Merge auftrag/x');
    assert.equal((await must('rev-list', '--count', 'HEAD')).trim(), '3');
  } finally {
    if (before === undefined) delete process.env.DEV_LOG_SECRET_KEY;
    else process.env.DEV_LOG_SECRET_KEY = before;
  }
  assert.equal(existsSync(marker), false, 'Ein Hook des Projekts wurde ausgeführt');
  assert.ok(envs.length > 0);
  for (const env of envs) {
    assert.equal(env.DEV_LOG_SECRET_KEY, undefined);
    assert.equal(env.DEV_LOG_DATABASE_URL, undefined);
    assert.equal(env.GIT_CONFIG_KEY_0, 'core.hooksPath');
    assert.equal(env.GIT_CONFIG_VALUE_0, '/dev/null');
  }
});

test('Gegenprobe: ohne Worker-Environment laufen die Test-Hooks wirklich', async () => {
  const { dir, marker } = await repositoryWithHooks();
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@x',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@x',
  };
  await writeFile(join(dir, 'a.txt'), 'a');
  await runCommand(['git', 'add', '-A'], dir, { env });
  assert.equal((await runCommand(['git', 'commit', '-q', '-m', 'x'], dir, { env })).exitCode, 0);
  assert.equal(existsSync(marker), true, 'Test-Hook ist nicht lauffähig – der Haupttest wäre wertlos');
});

test('Hook-Ordner sind für die Datei-Werkzeuge und den Claude-Wächter gesperrt', async () => {
  for (const path of [
    '.husky/pre-commit',
    '.githooks/pre-commit',
    '.git/hooks/pre-commit',
    'pakete/web/.husky/pre-push',
    'pakete/web/.githooks/post-merge',
    '.HUSKY/pre-commit',
    'pakete\\web\\.githooks\\pre-commit',
  ]) {
    assert.equal(protectedPath(path), true, path);
  }
  assert.equal(protectedPath('docs/husky.md'), false);
  assert.equal(protectedPath('src/githooks.ts'), false);

  const root = await mkdtemp(join(tmpdir(), 'git-hooks-guard-'));
  const policy = { create: true, edit: true, scopes: [] };
  for (const path of ['.husky/pre-commit', '.githooks/pre-commit', '.git/hooks/pre-commit', 'web/.githooks/x']) {
    const problem = fileProblem({ tool_name: 'Write', tool_input: { file_path: path }, cwd: root }, policy, root);
    assert.match(problem ?? '', /geschützt/, path);
  }
  assert.equal(
    fileProblem({ tool_name: 'Write', tool_input: { file_path: 'src/githooks.ts' }, cwd: root }, policy, root),
    null,
  );

  // Über einen Link auf den Hook-Ordner geht es auch nicht.
  await mkdir(join(root, '.husky'));
  await symlink(join(root, '.husky'), join(root, 'hooks'));
  await assert.rejects(resolveInside(root, 'hooks/pre-commit', true), /nicht erlaubt/);
  const linked = { tool_name: 'Write', tool_input: { file_path: 'hooks/pre-commit' }, cwd: root };
  assert.match(fileProblem(linked, policy, root) ?? '', /geschützt/);
});
