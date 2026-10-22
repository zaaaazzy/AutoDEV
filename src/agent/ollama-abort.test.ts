import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { BACKUP_DIRECTORY, executeTool, runOllamaAgent, type ToolContext } from './ollama-agent.js';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Ein per SIGKILL beendeter Prozess verschwindet erst, wenn das System ihn abräumt: kurz warten. */
async function gone(pid: number, waitMs = 2_000): Promise<boolean> {
  const until = Date.now() + waitMs;
  while (alive(pid)) {
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

async function project(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ollama-abort-'));
  await writeFile(join(directory, 'a.txt'), 'alt\n');
  return directory;
}

const call = (name: string, args: Record<string, unknown>) => ({ function: { name, arguments: args } });

test('runCommand: Abbruch beendet die ganze Prozessgruppe und räumt den Listener auf', async () => {
  const controller = new AbortController();
  const added: string[] = [];
  const removed: string[] = [];
  const signal = controller.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, ...rest: [EventListener, AddEventListenerOptions?]) => {
    added.push(type);
    add(type, ...rest);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type: string, ...rest: [EventListener]) => {
    removed.push(type);
    remove(type, ...rest);
  }) as typeof signal.removeEventListener;
  const startedAt = Date.now();
  let child = 0;
  const result = await runCommand(['sh', '-c', 'sleep 30 & echo "child $!"; sleep 30'], process.cwd(), {
    timeoutMs: 60_000,
    signal,
    onOutput: (output) => {
      const match = /child (\d+)/.exec(output);
      if (match && !child) {
        child = Number(match[1]);
        controller.abort();
      }
    },
  });
  assert.ok(Date.now() - startedAt < 15_000, `dauerte ${Date.now() - startedAt} ms`);
  assert.notEqual(result.exitCode, 0);
  assert.ok(child > 0);
  assert.equal(await gone(child), true, 'Hintergrundprozess wurde mit beendet');
  assert.deepEqual(added, ['abort']);
  assert.deepEqual(removed, ['abort']);
});

test('runCommand: ein schon abgebrochenes Signal startet keinen Prozess', async () => {
  const cwd = await project();
  const result = await runCommand(['sh', '-c', 'touch gestartet.txt'], cwd, { signal: AbortSignal.abort() });
  assert.equal(result.exitCode, 130);
  assert.equal(await exists(join(cwd, 'gestartet.txt')), false);
});

test('executeTool: nach dem Abbruch schreibt kein Werkzeug mehr und startet keinen Befehl', async () => {
  const cwd = await project();
  const ran: string[][] = [];
  const context: ToolContext = {
    cwd,
    canWrite: true,
    files: { create: true, edit: true, scopes: [] },
    changed: new Set(),
    backupRoot: join(cwd, BACKUP_DIRECTORY, 't'),
    timeoutMs: 1000,
    execute: async (command) => {
      ran.push(command);
      return { exitCode: 0, durationMs: 1, output: '' };
    },
    signal: AbortSignal.abort(),
  };
  assert.match(await executeTool(context, call('write_file', { path: 'neu.txt', content: 'x' })), /Abgebrochen/);
  assert.match(
    await executeTool(context, call('replace_in_file', { path: 'a.txt', old_text: 'alt', new_text: 'neu' })),
    /Abgebrochen/,
  );
  assert.match(await executeTool(context, call('run_command', { command: 'npm run build' })), /Abgebrochen/);
  assert.equal(await exists(join(cwd, 'neu.txt')), false);
  assert.deepEqual(ran, []);
  assert.equal(context.changed.size, 0);
});

test('Ollama-Agent: Abbruch während eines Befehls stoppt ihn samt Kindprozess, restliche write_file laufen nicht', async () => {
  const cwd = await project();
  const external = new AbortController();
  let child = 0;
  let requests = 0;
  const fetchImpl = (async () => {
    requests += 1;
    return new Response(
      JSON.stringify({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            call('run_command', { command: 'npm run build' }),
            call('write_file', { path: 'nach-abbruch.txt', content: 'x' }),
            call('replace_in_file', { path: 'a.txt', old_text: 'alt', new_text: 'überschrieben' }),
          ],
        },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  // Statt npm läuft ein echter Prozess mit Hintergrund-Kind; das Signal muss bis runCommand durchgereicht sein.
  const execute: CommandExecutor = (_command, commandCwd, options = {}) =>
    runCommand(['sh', '-c', 'sleep 30 & echo "child $!"; sleep 30'], commandCwd, {
      ...options,
      onOutput: (output) => {
        const match = /child (\d+)/.exec(output);
        if (match && !child) {
          child = Number(match[1]);
          external.abort();
        }
      },
    });
  const startedAt = Date.now();
  const result = await runOllamaAgent({
    prompt: 'Baue',
    role: 'developer',
    cwd,
    timeoutMs: 60_000,
    fetchImpl,
    execute,
    signal: external.signal,
    files: { create: true, edit: true, scopes: [] },
    commands: ['Bash(npm run build:*)'],
  });
  assert.ok(Date.now() - startedAt < 15_000, `dauerte ${Date.now() - startedAt} ms`);
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /Abgebrochen: Der Agent wurde gestoppt/);
  // Kein Zeitlimit-Text: der Abbruch gilt nicht als vorübergehender Fehler (kein Neuversuch, kein Autofix).
  assert.doesNotMatch(result.output, /Zeitlimit erreicht/);
  assert.ok(child > 0, 'Befehl wurde gestartet');
  assert.equal(await gone(child), true, 'Kindprozess läuft nach dem Abbruch nicht mehr');
  assert.equal(await exists(join(cwd, 'nach-abbruch.txt')), false);
  assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'alt\n');
  assert.equal(requests, 1, 'nach dem Abbruch keine weitere Modellanfrage');
});

test('Ollama-Agent: ein schon abgebrochenes Signal führt kein Werkzeug aus', async () => {
  const cwd = await project();
  let requests = 0;
  const fetchImpl = (async (_url: string, init: { signal?: AbortSignal }) => {
    requests += 1;
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return new Response(
      JSON.stringify({
        message: { role: 'assistant', content: '', tool_calls: [call('write_file', { path: 'x.txt', content: 'x' })] },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const result = await runOllamaAgent({
    prompt: 'Schreibe',
    role: 'developer',
    cwd,
    timeoutMs: 60_000,
    fetchImpl,
    signal: AbortSignal.abort(),
    files: { create: true, edit: true, scopes: [] },
    commands: [],
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /Abgebrochen/);
  assert.equal(await exists(join(cwd, 'x.txt')), false);
  assert.ok(requests <= 1);
});

test('Ollama-Agent: reines Zeitlimit stoppt den laufenden Befehl ebenfalls', async () => {
  const cwd = await project();
  let child = 0;
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            call('run_command', { command: 'npm run build' }),
            call('write_file', { path: 'nach-zeitlimit.txt', content: 'x' }),
          ],
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const execute: CommandExecutor = (_command, commandCwd, options = {}) =>
    runCommand(['sh', '-c', 'sleep 30 & echo "child $!"; sleep 30'], commandCwd, {
      ...options,
      onOutput: (output) => {
        child ||= Number(/child (\d+)/.exec(output)?.[1] ?? 0);
      },
    });
  const startedAt = Date.now();
  const result = await runOllamaAgent({
    prompt: 'Baue',
    role: 'developer',
    cwd,
    timeoutMs: 800,
    fetchImpl,
    execute,
    files: { create: true, edit: true, scopes: [] },
    commands: ['Bash(npm run build:*)'],
  });
  assert.ok(Date.now() - startedAt < 15_000, `dauerte ${Date.now() - startedAt} ms`);
  assert.match(result.output, /Zeitlimit erreicht/);
  assert.ok(child > 0);
  assert.equal(await gone(child), true);
  assert.equal(await exists(join(cwd, 'nach-zeitlimit.txt')), false);
});
