import assert from 'node:assert/strict';
import test from 'node:test';
import { CLAUDE_ASSISTANT_TOOLS, withAssistantPermissions } from './tool-permissions.js';

const CLAUDE = ['claude', '--model', 'opus', '--permission-mode', 'acceptEdits', '-p', '{prompt}'];

test('grants the Claude-backed assistant its service commands', () => {
  const command = withAssistantPermissions(CLAUDE, 'assistant');
  assert.deepEqual(command, ['claude', '--allowedTools', CLAUDE_ASSISTANT_TOOLS.join(','), ...CLAUDE.slice(1)]);
  assert.ok(CLAUDE_ASSISTANT_TOOLS.includes('Bash(docker compose up:*)'));
  assert.ok(!CLAUDE_ASSISTANT_TOOLS.some((tool) => tool.includes('git push')));
});

test('leaves other roles, other CLIs and explicit tool lists unchanged', () => {
  assert.deepEqual(withAssistantPermissions(CLAUDE, 'author'), CLAUDE);
  assert.deepEqual(withAssistantPermissions(['copilot', '-p', '{prompt}'], 'assistant'), ['copilot', '-p', '{prompt}']);
  const explicit = ['claude', '--allowedTools', 'Read', '-p', '{prompt}'];
  assert.deepEqual(withAssistantPermissions(explicit, 'assistant'), explicit);
  assert.equal(withAssistantPermissions(['/Users/x/.local/bin/claude', '-p'], 'assistant')[1], '--allowedTools');
});
