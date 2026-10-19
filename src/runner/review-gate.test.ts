import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { enterOrderBranch, finishOrderBranch, followPreview, mergeApprovedBranch } from './git-sync.js';
import { needsApproval, touchesUi } from './review-gate.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();

function repository(): { folder: string; agents: string } {
  const root = mkdtempSync(join(tmpdir(), 'review-'));
  const folder = join(root, 'App');
  mkdirSync(folder);
  writeFileSync(join(folder, 'a.txt'), 'start\n');
  git(folder, 'init', '-q', '-b', 'main');
  git(folder, 'config', 'user.email', 't@t');
  git(folder, 'config', 'user.name', 't');
  git(folder, 'add', '-A');
  git(folder, 'commit', '-q', '-m', 'init');
  git(folder, 'branch', 'sprint/s1');
  const agents = join(root, 'App-agents');
  git(folder, 'worktree', 'add', '-q', '--detach', agents, 'main');
  // Vorschau: Projektordner losgelöst auf dem Sprint-Stand.
  git(folder, 'checkout', '-q', '--detach', 'sprint/s1');
  return { folder, agents };
}

test('Oberflächen-Änderungen erkennen', () => {
  assert.ok(touchesUi(['frontend/src/app/x.ts']));
  assert.ok(touchesUi(['src/app/list.component.ts']));
  assert.ok(touchesUi(['src/styles.scss']));
  assert.ok(!touchesUi(['backend/src/db.ts', 'docs/readme.md']));
  assert.equal(needsApproval('off', ['frontend/a.html']), false);
  assert.equal(needsApproval('ui', ['backend/a.ts']), false);
  assert.equal(needsApproval('ui', ['frontend/a.html']), true);
  assert.equal(needsApproval('always', ['backend/a.ts']), true);
  assert.equal(needsApproval('always', []), false);
});

test('Freigabe: Auftrag wartet auf seinem Branch, wird erst nach Freigabe gemergt und die Vorschau zieht nach', async () => {
  const { folder, agents } = repository();
  const item = { id: 'abcdef12-0000', title: 'Neue Liste' };
  const branch = await enterOrderBranch(agents, item, 's1');
  assert.ok(branch);
  mkdirSync(join(agents, 'frontend'));
  writeFileSync(join(agents, 'frontend', 'list.html'), '<ul></ul>\n');

  const held = await finishOrderBranch(agents, item, branch!, 's1', true, undefined, (files) =>
    needsApproval('ui', files),
  );
  assert.equal(held.held, true);
  assert.equal(held.merged, false);
  // Sprint-Branch unverändert, Arbeitsordner wieder auf der Basis, Branch mit Commit vorhanden.
  assert.equal(git(agents, 'rev-parse', '--abbrev-ref', 'HEAD'), 'sprint/s1');
  assert.equal(git(folder, 'log', '--oneline', 'sprint/s1').split('\n').length, 1);
  assert.match(git(folder, 'show', '--name-only', '--format=', branch!.branch), /frontend\/list\.html/);

  const approved = await mergeApprovedBranch(agents, item, branch!.branch, branch!.base);
  assert.equal(approved.merged, true, approved.message);
  assert.match(git(folder, 'show', '--name-only', '--format=', 'sprint/s1^2'), /frontend\/list\.html/);
  assert.equal(git(folder, 'branch', '--list', branch!.branch), '');

  assert.match((await followPreview(folder, 'sprint/s1')) ?? '', /nachgezogen/);
  assert.equal(readFileSync(join(folder, 'frontend', 'list.html'), 'utf8'), '<ul></ul>\n');
});

test('Ohne Oberflächen-Änderung wird bei „ui“ sofort gemergt', async () => {
  const { agents } = repository();
  const item = { id: 'abcdef13-0000', title: 'Backend' };
  const branch = await enterOrderBranch(agents, item, 's1');
  writeFileSync(join(agents, 'server.ts'), 'export {};\n');
  const result = await finishOrderBranch(agents, item, branch!, 's1', true, undefined, (files) =>
    needsApproval('ui', files),
  );
  assert.equal(result.merged, true);
  assert.equal(result.held, undefined);
});

test('Vorschau bleibt bei eigener Arbeit oder ausgechecktem Branch unberührt', async () => {
  const { folder } = repository();
  writeFileSync(join(folder, 'a.txt'), 'meine Arbeit\n');
  assert.match((await followPreview(folder, 'sprint/s1')) ?? '', /offene Änderungen/);
  git(folder, 'checkout', '-q', '--', 'a.txt');
  git(folder, 'checkout', '-q', 'main');
  assert.equal(await followPreview(folder, 'sprint/s1'), null);
  assert.equal(git(folder, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});
