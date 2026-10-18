import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_PROMPT, parseTask, taskMessage } from './agent-tasks.js';
import { requiredRole } from './roles.js';

test('Agent-Aufgabe: Titel und Anweisung werden geprüft', () => {
  assert.deepEqual(parseTask({ title: ' Tests ', prompt: ' npm test ausführen ' }), {
    title: 'Tests',
    prompt: 'npm test ausführen',
    agentId: null,
  });
  const agentId = '0b6f1c7e-1d2a-4c3b-9e8f-112233445566';
  assert.equal((parseTask({ title: 'a', prompt: 'b', agentId }) as { agentId: string }).agentId, agentId);
  assert.equal(parseTask({ title: 'a', prompt: 'b', agentId: 'kein-agent' }), 'Ungültiger Agent.');
  assert.equal(typeof parseTask({ title: '', prompt: 'x' }), 'string');
  assert.equal(typeof parseTask({ title: 'x', prompt: 'y'.repeat(MAX_PROMPT + 1) }), 'string');
  assert.equal(typeof parseTask(null), 'string');
});

test('Agent-Aufgabe: Nachricht an den Assistenten trägt den Titel', () => {
  assert.equal(taskMessage({ title: 'Lint', prompt: 'Fehler beheben' }), 'Aufgabe „Lint“:\nFehler beheben');
});

test('Agent-Aufgaben verlangen die Rolle „Assistent nutzen“', () => {
  assert.equal(requiredRole('POST', '/api/projects/mainty/agent-tasks', {}), 'chat');
  assert.equal(requiredRole('PATCH', '/api/agent-tasks/abc', {}), 'chat');
  assert.equal(requiredRole('POST', '/api/agent-tasks/abc/run', {}), 'chat');
  assert.equal(requiredRole('POST', '/api/agent-tasks/abc/other', {}), 'admin');
});
