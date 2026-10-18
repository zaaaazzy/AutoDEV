import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAgentFailure } from './autofix.js';
import { changesWorkingTree } from './runner.js';

test('agent failures without code cause are recognised', () => {
  assert.equal(isAgentFailure('… gelesen\nZeitlimit erreicht'), true);
  assert.equal(isAgentFailure('Abbruch: Das Modell wiederholt sich („x…“). Schleife erkannt.'), true);
  assert.equal(isAgentFailure('Text\n\nDer Entwickler-Agent hat keine Dateien geändert.'), true);
  assert.equal(isAgentFailure('\nspawn claude ENOENT\n'), true);
  assert.equal(isAgentFailure('$ npm test → failed\nAssertionError: expected 2 to equal 3'), false);
});

test('developer and tester hold the working-tree lock, documentation agents do not', () => {
  assert.equal(changesWorkingTree({ phase: 'while_task', role: 'custom' }), true);
  assert.equal(changesWorkingTree({ phase: 'after_task', role: 'tester' }), true);
  assert.equal(changesWorkingTree({ phase: 'after_task', role: 'documenter' }), false);
  assert.equal(changesWorkingTree({ phase: 'pre_task', role: 'bug_reviewer' }), false);
});
