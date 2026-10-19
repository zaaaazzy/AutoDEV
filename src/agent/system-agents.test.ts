import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStoredCommand, readOnlyCommand } from './system-agents.js';

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

test('parseStoredCommand accepts only non-empty string arrays', () => {
  assert.deepEqual(parseStoredCommand('["copilot","-p"]'), ['copilot', '-p']);
  assert.equal(parseStoredCommand('kein json'), null);
  assert.equal(parseStoredCommand('[]'), null);
  assert.equal(parseStoredCommand(undefined), null);
});
