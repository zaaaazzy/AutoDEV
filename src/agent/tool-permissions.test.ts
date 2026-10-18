import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedCommand, withIgnoreScripts } from './tool-permissions.js';

test('npm installs of the local agent always run without install scripts', () => {
  assert.deepEqual(withIgnoreScripts(['npm', 'install']), ['npm', 'install', '--ignore-scripts']);
  assert.deepEqual(withIgnoreScripts(['npm', 'i', 'left-pad']), ['npm', 'i', 'left-pad', '--ignore-scripts']);
  assert.deepEqual(withIgnoreScripts(['npm', 'ci']), ['npm', 'ci', '--ignore-scripts']);
  assert.deepEqual(withIgnoreScripts(['npm', 'ci', '--ignore-scripts']), ['npm', 'ci', '--ignore-scripts']);
  assert.deepEqual(withIgnoreScripts(['npm', 'test']), ['npm', 'test']);
  assert.ok(isAllowedCommand('npm install left-pad --ignore-scripts'));
  assert.ok(!isAllowedCommand('npm install left-pad --foreground-scripts'));
});
