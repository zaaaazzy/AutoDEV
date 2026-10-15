import assert from 'node:assert/strict';
import test from 'node:test';
import { parseChatReply } from './chat.js';

test('splits chat replies into text and delegated tasks', () => {
  const { text, tasks } = parseChatReply('Mache ich.\n@@TASK {"title":"Login fixen","description":"Bug 4","agent":"Dev"}\n@@TASK {"title":""}\n@@TASK kaputt');
  assert.deepEqual(tasks, [{ title: 'Login fixen', description: 'Bug 4', agent: 'Dev' }]);
  assert.equal(text, 'Mache ich.\n@@TASK kaputt');
});
