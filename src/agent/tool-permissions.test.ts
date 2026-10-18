import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLAUDE_ASSISTANT_TOOLS,
  isAllowedCommand,
  withAssistantPermissions,
  withIgnoreScripts,
} from './tool-permissions.js';

const CLAUDE = ['claude', '--model', 'opus', '--permission-mode', 'acceptEdits', '-p', '{prompt}'];

test('grants the Claude-backed assistant and developer their commands and log folders', () => {
  for (const role of ['assistant', 'developer']) {
    const command = withAssistantPermissions(CLAUDE, role, ['/home/me/Library/Logs']);
    assert.deepEqual(command, [
      'claude',
      '--add-dir',
      '/home/me/Library/Logs',
      '--allowedTools',
      CLAUDE_ASSISTANT_TOOLS.join(','),
      ...CLAUDE.slice(1),
    ]);
  }
  assert.ok(CLAUDE_ASSISTANT_TOOLS.includes('Bash(docker compose up:*)'));
  for (const tool of ['netstat', 'npm --prefix', 'npm install --ignore-scripts', 'npm ci --ignore-scripts']) {
    assert.ok(CLAUDE_ASSISTANT_TOOLS.includes(`Bash(${tool}:*)`), tool);
  }
  assert.ok(CLAUDE_ASSISTANT_TOOLS.includes('WebFetch(domain:localhost)'));
  assert.ok(!CLAUDE_ASSISTANT_TOOLS.some((tool) => /git push|rm |sudo|kill|com\.devlog/.test(tool)));
  assert.ok(CLAUDE_ASSISTANT_TOOLS.some((tool) => /^Bash\(launchctl kickstart -k gui\/\d+\/ch\.\*\)$/.test(tool)));
});

test('leaves other roles, other CLIs and explicit tool lists unchanged', () => {
  assert.deepEqual(withAssistantPermissions(CLAUDE, 'author'), CLAUDE);
  assert.deepEqual(withAssistantPermissions(CLAUDE, 'tester'), CLAUDE);
  assert.deepEqual(withAssistantPermissions(['copilot', '-p', '{prompt}'], 'assistant'), ['copilot', '-p', '{prompt}']);
  const explicit = ['claude', '--allowedTools', 'Read', '-p', '{prompt}'];
  assert.deepEqual(withAssistantPermissions(explicit, 'assistant'), explicit);
  assert.equal(withAssistantPermissions(['/Users/x/.local/bin/claude', '-p'], 'assistant', [])[1], '--allowedTools');
});

test('never grants shell commands that read arbitrary files, send data or start arbitrary packages', () => {
  for (const tool of [
    'tail',
    'head',
    'cat',
    'grep',
    'ls',
    'wc',
    'curl',
    'npx --prefix',
    'npx tsx',
    'npm install',
    'npm ci',
  ]) {
    assert.ok(!CLAUDE_ASSISTANT_TOOLS.includes(`Bash(${tool}:*)`), tool);
  }
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
