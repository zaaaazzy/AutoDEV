import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubWebUrl, parseGitLog } from './git-graph.js';

test('GitHub-Webadresse aus SSH- und HTTPS-Remotes', () => {
  assert.equal(githubWebUrl('git@github.com:pm/mainty.git\n'), 'https://github.com/pm/mainty');
  assert.equal(githubWebUrl('https://github.com/pm/mainty'), 'https://github.com/pm/mainty');
  assert.equal(githubWebUrl('ssh://git@github.com/pm/mainty.git'), 'https://github.com/pm/mainty');
  assert.equal(githubWebUrl('git@gitlab.com:pm/mainty.git'), null);
  assert.equal(githubWebUrl(''), null);
});

test('git log wird in Commits mit Eltern und Branches zerlegt', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const c = 'c'.repeat(40);
  const commits = parseGitLog(
    [
      `${a}\x1f${b} ${c}\x1fAnna\x1f2026-10-18T10:00:00+02:00\x1fMerge sprint\x1fHEAD -> main, origin/main, origin/HEAD, tag: v1`,
      `${b}\x1f\x1fBen\x1f2026-10-17T10:00:00+02:00\x1fStart\x1f`,
      'kaputt',
    ].join('\n'),
  );
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0]!.parents, [b, c]);
  assert.deepEqual(commits[0]!.refs, ['main', 'origin/main', 'tag: v1']);
  assert.deepEqual(commits[1]!.parents, []);
});
