import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeNextRun, MAX_PROMPT, parseTask, taskMessage } from './agent-tasks.js';
import { declaredAccess, requiredRole } from './route-table.test.js';

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
  // Den Verlauf lesen braucht keine Rolle, nur das Projekt der Aufgabe.
  assert.equal(declaredAccess('GET', '/api/agent-tasks/abc/runs')?.tenant, 'agent-tasks');
  assert.equal(requiredRole('POST', '/api/agent-tasks/abc/pause', {}), 'chat');
  assert.equal(requiredRole('POST', '/api/agent-tasks/abc/resume', {}), 'chat');
  assert.equal(requiredRole('POST', '/api/agent-tasks/abc/other', {}), 'admin');
});

test('Agent-Aufgabe: Zeitplan, Ziel und Zeitfenster werden geprüft', () => {
  const base = { title: 'Audit', prompt: 'npm audit' };
  assert.deepEqual(parseTask({ ...base, schedule: ' 0  3 * * * ', outputTarget: 'bug', runWindow: '22:00 - 06:00' }), {
    ...base,
    agentId: null,
    schedule: '0 3 * * *',
    outputTarget: 'bug',
    runWindow: '22:00-06:00',
  });
  assert.equal((parseTask({ ...base, schedule: '' }) as { schedule: unknown }).schedule, null);
  assert.equal((parseTask({ ...base, runWindow: '' }) as { runWindow: unknown }).runWindow, null);
  assert.equal((parseTask({ ...base, enabled: false }) as { enabled: unknown }).enabled, false);
  assert.match(parseTask({ ...base, schedule: '0 3 * *' }) as string, /5 Felder/);
  assert.equal(parseTask({ ...base, schedule: '0 0 30 2 *' }), 'Der Zeitplan trifft nie zu.');
  assert.equal(parseTask({ ...base, outputTarget: 'mail' }), 'Ungültiges Ziel für das Ergebnis.');
  assert.match(parseTask({ ...base, runWindow: '22-6' }) as string, /HH:MM/);
  assert.equal(parseTask({ ...base, enabled: 'ja' }), 'Ungültiger Wert für „aktiv“.');
});

test('Agent-Aufgabe: nächster Lauf nur mit Zeitplan und aktiv', () => {
  const now = new Date('2026-10-20T10:00:00Z');
  assert.equal(computeNextRun({ schedule: null, runWindow: null, enabled: true }, now), null);
  assert.equal(computeNextRun({ schedule: '0 7 * * 1', runWindow: null, enabled: false }, now), null);
  assert.equal(
    computeNextRun({ schedule: '0 7 * * 1', runWindow: null, enabled: true }, now)?.toISOString(),
    '2026-10-26T06:00:00.000Z',
  );
});

test('der Kommentar aus der Bestätigung wird an die Aufgabe angehängt', () => {
  assert.equal(taskMessage({ title: 'Tests', prompt: 'npm test' }), 'Aufgabe „Tests“:\nnpm test');
  assert.equal(
    taskMessage({ title: 'Tests', prompt: 'npm test' }, '  nur Backend  '),
    'Aufgabe „Tests“:\nnpm test\n\nHinweis dazu: nur Backend',
  );
});
