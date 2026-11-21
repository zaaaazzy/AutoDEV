import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultAgentCommand } from './runner-selection.js';

test('defaultAgentCommand: leer → null, JSON-Array → Array, sonst wie in der Shell zerlegt', () => {
  assert.equal(defaultAgentCommand({}), null);
  assert.equal(defaultAgentCommand({ DEV_LOG_AGENT_COMMAND: '   ' }), null);
  assert.deepEqual(defaultAgentCommand({ DEV_LOG_AGENT_COMMAND: '["claude", "-p"]' }), ['claude', '-p']);
  assert.deepEqual(defaultAgentCommand({ DEV_LOG_AGENT_COMMAND: 'claude -p --model opus' }), [
    'claude',
    '-p',
    '--model',
    'opus',
  ]);
  assert.deepEqual(
    defaultAgentCommand({ DEV_LOG_AGENT_COMMAND: 'claude -p --append-system-prompt "kurz antworten"' }),
    ['claude', '-p', '--append-system-prompt', 'kurz antworten'],
  );
});

test('defaultAgentCommand: ungültiges JSON oder offene Anführungszeichen → Warnung und null', () => {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => warnings.push(message);
  try {
    assert.equal(defaultAgentCommand({ DEV_LOG_AGENT_COMMAND: '[kaputt' }), null);
    assert.equal(defaultAgentCommand({ DEV_LOG_AGENT_COMMAND: 'claude -p "offen' }), null);
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 2);
  assert.match(warnings[1] ?? '', /Anführungszeichen nicht geschlossen/);
});
