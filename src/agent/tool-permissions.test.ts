import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedCommand, PERMISSION_GROUPS, rulesAllow, withIgnoreScripts } from './tool-permissions.js';

test('agents can never call the GitHub CLI (gh stays reserved for the worker)', () => {
  const rules = PERMISSION_GROUPS.flatMap((group) => group.rules);
  for (const command of [
    'gh auth status',
    'gh pr create --title x',
    'gh pr merge 1 --merge',
    'gh issue list',
    'gh api /user',
  ]) {
    assert.ok(!isAllowedCommand(command), command);
    assert.ok(!rulesAllow(rules, command), command);
  }
  assert.ok(!rules.some((rule) => /^Bash\(gh\b/.test(rule)));
});

test('npm installs of the local agent always run without install scripts', () => {
  assert.deepEqual(withIgnoreScripts(['npm', 'install']), ['npm', 'install', '--ignore-scripts']);
  assert.deepEqual(withIgnoreScripts(['npm', 'i', 'left-pad']), ['npm', 'i', 'left-pad', '--ignore-scripts']);
  assert.deepEqual(withIgnoreScripts(['npm', 'ci']), ['npm', 'ci', '--ignore-scripts']);
  assert.deepEqual(withIgnoreScripts(['npm', 'ci', '--ignore-scripts']), ['npm', 'ci', '--ignore-scripts']);
  assert.deepEqual(withIgnoreScripts(['npm', 'test']), ['npm', 'test']);
  assert.ok(isAllowedCommand('npm install left-pad --ignore-scripts'));
  assert.ok(!isAllowedCommand('npm install left-pad --foreground-scripts'));
});
