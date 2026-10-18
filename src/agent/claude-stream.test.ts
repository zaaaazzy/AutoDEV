import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommandExecutor } from '../core/command.js';
import { createStreamParser, executeAgentCommand, withStreamJson } from './claude-stream.js';

const line = (event: unknown): string => `${JSON.stringify(event)}\n`;
const toolUse = (name: string, input: Record<string, unknown>) =>
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const RESULT = line({
  type: 'result',
  result: 'Fertig umgesetzt.',
  is_error: false,
  usage: { input_tokens: 10, output_tokens: 5 },
});

test('adds stream-json only to claude commands without an output format', () => {
  assert.deepEqual(withStreamJson(['claude', '-p', 'x']), [
    'claude',
    '--output-format',
    'stream-json',
    '--verbose',
    '-p',
    'x',
  ]);
  assert.deepEqual(withStreamJson(['claude', '--output-format', 'json', '-p']), [
    'claude',
    '--output-format',
    'json',
    '-p',
  ]);
  assert.deepEqual(withStreamJson(['copilot', '-p']), ['copilot', '-p']);
});

test('parses split lines into readable actions and the final answer', () => {
  const actions: string[] = [];
  const parser = createStreamParser('/repo', (message) => actions.push(message));
  const stream = toolUse('Edit', { file_path: '/repo/src/app.ts' }) + toolUse('Bash', { command: 'npm test' }) + RESULT;
  parser.push(stream.slice(0, 40));
  parser.push(stream.slice(40));
  assert.deepEqual(actions, ['Bearbeitet src/app.ts', 'Führt aus: npm test']);
  assert.deepEqual(parser.result(), { text: 'Fertig umgesetzt.', isError: false, tokens: 15, costUsd: 0 });
});

test('executeAgentCommand streams actions for claude and returns the plain answer', async () => {
  const calls: string[][] = [];
  const live: string[] = [];
  const actions: string[] = [];
  const execute: CommandExecutor = async (command, _cwd, options) => {
    calls.push(command);
    const raw =
      toolUse('Read', { file_path: '/repo/README.md' }) +
      line({ type: 'assistant', message: { content: [{ type: 'text', text: '## Plan\nErst lesen.' }] } }) +
      RESULT;
    options?.onChunk?.(raw);
    return { exitCode: 0, durationMs: 1, output: raw };
  };
  const result = await executeAgentCommand(execute, ['claude', '-p', 'Hi'], '/repo', {
    onOutput: (output) => live.push(output),
    onAction: (message) => actions.push(message),
  });
  assert.equal(calls[0]?.[1], '--output-format');
  assert.deepEqual(actions, ['Liest README.md', '## Plan Erst lesen.']);
  assert.equal(live.at(-1), '## Plan\nErst lesen.');
  assert.equal(result.output, 'Fertig umgesetzt.');
  assert.equal(result.tokens, 15);

  const plain = await executeAgentCommand(execute, ['copilot', '-p', 'Hi'], '/repo', {});
  assert.deepEqual(calls[1], ['copilot', '-p', 'Hi']);
  assert.notEqual(plain.output, 'Fertig umgesetzt.');
});

test('an aborted claude run keeps readable text instead of raw JSON', async () => {
  const execute: CommandExecutor = async (_command, _cwd, options) => {
    const raw =
      line({ type: 'system', subtype: 'init' }) +
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Prüfe den Stand.' }] } }) +
      '\nProcess ended by SIGKILL (timeout or kill).\n';
    options?.onChunk?.(raw);
    return { exitCode: 1, durationMs: 1, output: raw };
  };
  const result = await executeAgentCommand(execute, ['claude', '-p', 'Hi'], '/repo', {});
  assert.equal(result.output, 'Prüfe den Stand.\n\nProcess ended by SIGKILL (timeout or kill).');
  assert.equal(result.exitCode, 1);
});

test('continues a claude session with --resume and reports the session id', async () => {
  const calls: string[][] = [];
  const execute: CommandExecutor = async (command, _cwd, options) => {
    calls.push(command);
    const raw = line({ type: 'system', subtype: 'init', session_id: 'abc-123' }) + RESULT;
    options?.onChunk?.(raw);
    return { exitCode: 0, durationMs: 1, output: raw };
  };
  const result = await executeAgentCommand(execute, ['claude', '-p', 'Ja'], '/repo', { resumeSession: 'abc-123' });
  assert.deepEqual(calls[0]?.slice(0, 5), ['claude', '--output-format', 'stream-json', '--verbose', '--resume']);
  assert.equal(calls[0]?.[5], 'abc-123');
  assert.equal(result.sessionId, 'abc-123');
});
