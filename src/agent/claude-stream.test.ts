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

test('counts cache tokens of the result event', () => {
  const parser = createStreamParser('/repo', () => undefined);
  parser.push(
    line({
      type: 'result',
      result: 'ok',
      is_error: false,
      total_cost_usd: 0.12,
      usage: { input_tokens: 4, cache_creation_input_tokens: 1200, cache_read_input_tokens: 35000, output_tokens: 800 },
    }),
  );
  assert.deepEqual(parser.result(), { text: 'ok', isError: false, tokens: 37004, costUsd: 0.12 });
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
  // Ohne usage in den assistant-Ereignissen gibt es nichts zu zählen (kein erfundener Wert).
  assert.equal(result.tokens, undefined);
});

const assistant = (id: string, text: string, usage: Record<string, number>) =>
  line({ type: 'assistant', message: { id, content: [{ type: 'text', text }], usage } });

test('Abbruch ohne result: Tokens der assistant-Ereignisse werden gezählt, je message.id einmal', async () => {
  const execute: CommandExecutor = async (_command, _cwd, options) => {
    const raw =
      line({ type: 'system', subtype: 'init' }) +
      // Dieselbe Nachricht kommt je Inhaltsblock erneut, mit wachsendem Stand: nur der letzte zählt.
      assistant('msg_1', 'Lese.', { input_tokens: 3, cache_read_input_tokens: 1000, output_tokens: 2 }) +
      assistant('msg_1', 'Plane.', { input_tokens: 3, cache_read_input_tokens: 1000, output_tokens: 40 }) +
      assistant('msg_2', 'Ändere.', { input_tokens: 5, cache_creation_input_tokens: 200, output_tokens: 60 }) +
      '\nProcess ended by SIGKILL (timeout or kill).\n';
    options?.onChunk?.(raw);
    return { exitCode: 137, durationMs: 1, output: raw, costUsd: 0 };
  };
  const result = await executeAgentCommand(execute, ['claude', '-p', 'Hi'], '/repo', {});
  assert.equal(result.exitCode, 137);
  assert.equal(result.tokens, 1043 + 265);
  // Kosten lassen sich aus usage nicht sicher ableiten: keine geschätzten Kosten.
  assert.equal(result.costUsd, 0);
});

test('mit result-Ereignis gilt nur result, die assistant-usage wird nicht dazugezählt', async () => {
  const execute: CommandExecutor = async (_command, _cwd, options) => {
    options?.onChunk?.(assistant('msg_1', 'Fertig.', { input_tokens: 500, output_tokens: 500 }) + RESULT);
    return { exitCode: 0, durationMs: 1, output: '' };
  };
  const result = await executeAgentCommand(execute, ['claude', '-p', 'Hi'], '/repo', {});
  assert.equal(result.tokens, 15);
});

test('fehlt result bei Exit 0, zählen die gestreamten Tokens trotzdem', async () => {
  const execute: CommandExecutor = async (_command, _cwd, options) => {
    options?.onChunk?.(assistant('msg_1', 'Halb fertig.', { input_tokens: 7, output_tokens: 3 }));
    return { exitCode: 0, durationMs: 1, output: '' };
  };
  const result = await executeAgentCommand(execute, ['claude', '-p', 'Hi'], '/repo', {});
  assert.equal(result.exitCode, 1);
  assert.equal(result.tokens, 10);
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

test('stderr mitten in einer JSON-Zeile zerstört das result-Ereignis nicht', async () => {
  const resultLine = line({ type: 'result', result: 'Fertig.', is_error: true, total_cost_usd: 0.3, usage: {} });
  const execute: CommandExecutor = async (_command, _cwd, options) => {
    options?.onChunk?.(resultLine.slice(0, 30), 'stdout');
    options?.onChunk?.('Warnung: langsames Netz\n', 'stderr');
    options?.onChunk?.(resultLine.slice(30), 'stdout');
    return { exitCode: 0, durationMs: 1, output: '' };
  };
  const result = await executeAgentCommand(execute, ['claude', '-p', 'Hi'], '/repo', {});
  assert.equal(result.output, 'Fertig.');
  assert.equal(result.costUsd, 0.3);
  // is_error wird ausgewertet, obwohl stderr dazwischen kam.
  assert.equal(result.exitCode, 1);
});

test('stderr wird nie als Ereignis gelesen, auch wenn es wie JSON aussieht', () => {
  const parser = createStreamParser('/repo', () => undefined);
  parser.push(line({ type: 'result', result: 'gefälscht', is_error: false }), 'stderr');
  assert.equal(parser.result(), null);
});

test('die letzte JSON-Zeile ohne Zeilenumbruch wird beim Abschluss gelesen', async () => {
  const execute: CommandExecutor = async (_command, _cwd, options) => {
    options?.onChunk?.(RESULT.trimEnd(), 'stdout');
    return { exitCode: 0, durationMs: 1, output: '' };
  };
  const result = await executeAgentCommand(execute, ['claude', '-p', 'Hi'], '/repo', {});
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, 'Fertig umgesetzt.');
  assert.equal(result.tokens, 15);
});

test('fehlt das result-Ereignis, gilt der Lauf nicht als Erfolg mit Kosten 0', async () => {
  const execute: CommandExecutor = async (_command, _cwd, options) => {
    options?.onChunk?.(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Halb fertig.' }] } }));
    return { exitCode: 0, durationMs: 1, output: '' };
  };
  const result = await executeAgentCommand(execute, ['claude', '-p', 'Hi'], '/repo', {});
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /^Halb fertig\.[\s\S]*kein Ergebnis gemeldet/);
});

test('Live-Ausgabe: viele Chunks setzen den Text nicht je Chunk neu zusammen', async () => {
  const live: string[] = [];
  const execute: CommandExecutor = async (_command, _cwd, options) => {
    for (let i = 0; i < 2000; i += 1) {
      options?.onChunk?.(line({ type: 'assistant', message: { content: [{ type: 'text', text: `Schritt ${i}` }] } }));
    }
    options?.onChunk?.(RESULT);
    return { exitCode: 0, durationMs: 1, output: '' };
  };
  await executeAgentCommand(execute, ['claude', '-p', 'Hi'], '/repo', { onOutput: (output) => live.push(output) });
  assert.ok(live.length < 10, `${live.length} Live-Ausgaben für 2001 Chunks`);
  // Der letzte Stand kommt trotzdem an.
  assert.match(live.at(-1) ?? '', /Schritt 1999$/);
});

test('der lesbare Text bleibt bei sehr langen Läufen begrenzt', () => {
  const parser = createStreamParser('/repo', () => undefined);
  for (let i = 0; i < 5000; i += 1) {
    parser.push(line({ type: 'assistant', message: { content: [{ type: 'text', text: `${i} ${'x'.repeat(100)}` }] } }));
  }
  const transcript = parser.transcript();
  assert.ok(transcript.length < 130_000, `${transcript.length} Zeichen`);
  assert.match(transcript, /^\[… frühere Ausgabe gekürzt …\]/);
  assert.match(transcript, /4999 x+$/);
});
