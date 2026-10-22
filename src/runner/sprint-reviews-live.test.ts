import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { tagMergedSprint } from './git-sync/sprint-reviews.js';

const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

/**
 * Aufbau wie bei AIdeation: GitHub (origin), der Live-Ordner der Menschen mit main und ein eigener Agent-Ordner
 * (Worktree) auf dem Sprint-Branch. Auf GitHub wurde der Pull Request gemergt: origin/main ist einen Commit weiter.
 */
async function setup(): Promise<{ live: string; agents: string; mergedOnGithub: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pr-live-'));
  const origin = join(root, 'origin.git');
  const live = join(root, 'live');
  const agents = join(root, 'agents');
  const elsewhere = join(root, 'github');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', origin, live], { stdio: 'pipe' });
  for (const [key, value] of [
    ['user.email', 'mensch@example.com'],
    ['user.name', 'Mensch'],
  ])
    run(live, 'config', key, value);
  await writeFile(join(live, 'app.txt'), 'v1\n');
  run(live, 'add', '-A');
  run(live, 'commit', '-m', 'v1');
  run(live, 'push', 'origin', 'main');
  run(live, 'worktree', 'add', '-b', 'sprint/sprint-1', agents);
  // Merge des Pull Requests auf GitHub, simuliert über einen zweiten Klon.
  execFileSync('git', ['clone', origin, elsewhere], { stdio: 'pipe' });
  run(elsewhere, 'config', 'user.email', 'github@example.com');
  run(elsewhere, 'config', 'user.name', 'GitHub');
  await writeFile(join(elsewhere, 'app.txt'), 'v2 aus dem Sprint\n');
  run(elsewhere, 'commit', '-am', 'Merge pull request #1');
  run(elsewhere, 'push', 'origin', 'main');
  return { live, agents, mergedOnGithub: run(elsewhere, 'rev-parse', 'HEAD') };
}

const sprint = { id: '7a5d5fe6-e950-47e0-8830-bc51829dbb81', name: 'Sprint 1' };

test('PR gemergt: main im Live-Ordner wird nachgezogen, damit der Sprint live gehen kann', async () => {
  const { live, agents, mergedOnGithub } = await setup();
  const result = await tagMergedSprint(agents, sprint);
  assert.equal(result.mainUpdated, true, result.log.join(' '));
  assert.equal(run(live, 'rev-parse', 'HEAD'), mergedOnGithub);
  assert.equal(run(live, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});

test('PR gemergt, aber offene Änderungen im Live-Ordner: nichts anfassen, nur Hinweis', async () => {
  const { live, agents, mergedOnGithub } = await setup();
  await writeFile(join(live, 'app.txt'), 'von Hand geändert\n');
  const result = await tagMergedSprint(agents, sprint);
  assert.equal(result.mainUpdated, false);
  assert.notEqual(run(live, 'rev-parse', 'HEAD'), mergedOnGithub);
  assert.match(result.log.join(' '), /offene Änderungen – dort mit „git pull“ übernehmen/);
  assert.equal(run(live, 'diff', '--name-only'), 'app.txt', 'die Änderung bleibt erhalten');
});
