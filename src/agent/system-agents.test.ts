import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  asCommand,
  dashboardCommand,
  fallbackProgram,
  readOnlyCommand,
  settingCommand,
  systemAgentUsage,
} from './system-agents.js';

const CLAUDE = ['claude', '--model', 'opus', '--dangerously-skip-permissions', '-p'];
const setting = (allowTools = false) => ({ model: null, command: CLAUDE, allowTools });

test('settingCommand: Assistent voll, Analyse/Schätzung nur mit Freigabe, Visionär immer lesend', () => {
  assert.deepEqual(settingCommand('assistant', setting()), CLAUDE);
  assert.deepEqual(settingCommand('analyst', setting()), ['claude', '--model', 'opus', '-p']);
  assert.deepEqual(settingCommand('analyst', setting(true)), CLAUDE);
  assert.deepEqual(settingCommand('visionary', setting(true)), ['claude', '--model', 'opus', '-p']);
  assert.equal(settingCommand('bug_reviewer', setting()), null);
  assert.equal(settingCommand('visionary', undefined), null);
});

test('dashboardCommand: Visionär aus den Einstellungen, Auftragsautor bewusst nicht', async () => {
  const pool = {
    query: async () => ({ rows: [{ command: CLAUDE, allow_tools: false }] }),
  } as unknown as Pool;
  assert.deepEqual(await dashboardCommand(pool, 'visionary'), ['claude', '--model', 'opus', '-p']);
  assert.equal(await dashboardCommand(pool, 'author'), null);
  assert.deepEqual(await dashboardCommand(pool, 'routine'), ['claude', '--model', 'opus', '-p']);
});

test('systemAgentUsage: Einstellung, dann DEV_LOG_AGENT_COMMAND, sonst lokales Modell', () => {
  assert.deepEqual(systemAgentUsage('visionary', setting(), null, 'qwen3.5:27b'), {
    kind: 'cli',
    source: 'settings',
    command: ['claude', '--model', 'opus', '-p'],
    model: 'qwen3.5:27b',
  });
  assert.equal(systemAgentUsage('visionary', undefined, ['claude'], 'm').source, 'environment');
  assert.equal(systemAgentUsage('visionary', undefined, null, 'm').kind, 'ollama');
  // Die Schnellschätzung nimmt keinen Umgebungs-Befehl.
  assert.equal(systemAgentUsage('author', undefined, ['claude'], 'm').kind, 'ollama');
});

test('fallbackProgram: nur der Programmname, ungültiger Wert ergibt null', () => {
  assert.deepEqual(fallbackProgram({ DEV_LOG_AGENT_COMMAND: '/usr/bin/claude --api-key geheim' }), ['claude']);
  assert.equal(fallbackProgram({}), null);
  assert.equal(fallbackProgram({ DEV_LOG_AGENT_COMMAND: '[kaputt' }), null);
});

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
