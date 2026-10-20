import assert from 'node:assert/strict';
import test from 'node:test';
import { asCommand, readOnlyCommand } from './system-agents.js';

test('readOnlyCommand strips permission flags of the CLI presets', () => {
  assert.deepEqual(
    readOnlyCommand(['claude', '--model', 'opus', '--permission-mode', 'acceptEdits', '-p', '{prompt}']),
    ['claude', '--model', 'opus', '-p', '{prompt}'],
  );
  assert.deepEqual(readOnlyCommand(['copilot', '--allow-all-tools', '-p', '{prompt}']), ['copilot', '-p', '{prompt}']);
  assert.deepEqual(readOnlyCommand(['gemini', '--yolo', '--approval-mode=auto_edit', '-p', '{prompt}']), [
    'gemini',
    '-p',
    '{prompt}',
  ]);
});

test('readOnlyCommand strips --settings and --add-dir', () => {
  assert.deepEqual(readOnlyCommand(['claude', '--settings', 'perm.json', '--add-dir', '/a', '/b', '-p', '{prompt}']), [
    'claude',
    '-p',
    '{prompt}',
  ]);
  assert.deepEqual(readOnlyCommand(['claude', '--settings={"a":1}', '--add-dir=/x', '--model', 'opus']), [
    'claude',
    '--model',
    'opus',
  ]);
});

test('asCommand accepts only non-empty string arrays', () => {
  assert.deepEqual(asCommand(['copilot', '-p']), ['copilot', '-p']);
  assert.equal(asCommand('kein array'), null);
  assert.equal(asCommand([]), null);
  assert.equal(asCommand([1]), null);
  assert.equal(asCommand(null), null);
});
