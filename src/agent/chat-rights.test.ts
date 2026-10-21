import assert from 'node:assert/strict';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BACKUP_DIRECTORY, executeTool, runOllamaAgent } from './ollama-agent.js';

/** Modell, das genau einen Werkzeugaufruf versucht und danach antwortet. */
function scripted(name: string, args: Record<string, unknown>): typeof fetch {
  return (async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as { messages: { role: string }[] };
    const message = request.messages.some((entry) => entry.role === 'tool')
      ? { role: 'assistant', content: 'fertig' }
      : { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] };
    return new Response(JSON.stringify({ message }), { status: 200 });
  }) as unknown as typeof fetch;
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const tempProject = (): Promise<string> => mkdtemp(join(tmpdir(), 'chat-rights-'));

test('Chat-Assistent ohne Rechte-Kontext schreibt nicht (fail-closed)', async () => {
  const cwd = await tempProject();
  const result = await runOllamaAgent({
    prompt: 'x',
    role: 'assistant',
    cwd,
    timeoutMs: 5000,
    fetchImpl: scripted('write_file', { path: 'neu.txt', content: 'x' }),
  });
  assert.equal(await exists(join(cwd, 'neu.txt')), false);
  assert.doesNotMatch(result.output, /Geänderte Dateien/);
});

test('Chat-Assistent mit Rechte-Kontext respektiert PROTECTED_PATH', async () => {
  const cwd = await tempProject();
  for (const path of ['.mcp.json', '.claude/settings.json', '.husky/pre-commit', 'server.pem']) {
    await runOllamaAgent({
      prompt: 'x',
      role: 'assistant',
      cwd,
      timeoutMs: 5000,
      fetchImpl: scripted('write_file', { path, content: '{}' }),
      files: { create: true, edit: true, scopes: [] },
      commands: [],
    });
    assert.equal(await exists(join(cwd, path)), false, `${path} darf nicht geschrieben werden`);
  }
});

test('Chat-Assistent mit Rechte-Kontext darf erlaubte Dateien schreiben', async () => {
  const cwd = await tempProject();
  await runOllamaAgent({
    prompt: 'x',
    role: 'assistant',
    cwd,
    timeoutMs: 5000,
    fetchImpl: scripted('write_file', { path: 'ok.txt', content: 'x' }),
    files: { create: true, edit: true, scopes: [] },
    commands: [],
  });
  assert.equal(await exists(join(cwd, 'ok.txt')), true);
});

test('Chat-Assistent führt nicht freigegebene Projektbefehle (Docker) nicht aus', async () => {
  const cwd = await tempProject();
  const ran: string[][] = [];
  await runOllamaAgent({
    prompt: 'x',
    role: 'assistant',
    cwd,
    timeoutMs: 5000,
    fetchImpl: scripted('run_command', { command: 'docker compose down' }),
    files: { create: false, edit: false, scopes: [] },
    commands: ['git status'],
    execute: async (command) => {
      ran.push(command);
      return { exitCode: 0, durationMs: 1, output: '' };
    },
  });
  assert.deepEqual(ran, []);
});

test('Ollama-Pfad: gefährliche npm-Optionen sind auch bei freigegebenem npm run build gesperrt', async () => {
  const cwd = await tempProject();
  const ran: string[][] = [];
  for (const command of [
    'npm run build --script-shell=docs/x.sh',
    'npm run build --scr=docs/x.sh',
    'npm run build --node-options=--require=./docs/x.js',
    'npm run build --prefix=/tmp',
    // Gegenprobe: ohne Option läuft der freigegebene Befehl.
    'npm run build',
  ]) {
    await runOllamaAgent({
      prompt: 'x',
      role: 'assistant',
      cwd,
      timeoutMs: 5000,
      fetchImpl: scripted('run_command', { command }),
      files: { create: true, edit: true, scopes: ['docs'] },
      commands: ['Bash(npm run build:*)'],
      execute: async (parts) => {
        ran.push(parts);
        return { exitCode: 0, durationMs: 1, output: '' };
      },
    });
  }
  assert.deepEqual(ran, [['npm', 'run', 'build']]);
});

test('Ollama-Pfad: Werkzeuge ohne Dateirechte schreiben nicht, auch mit canWrite', async () => {
  const cwd = await tempProject();
  const result = await executeTool(
    {
      cwd,
      canWrite: true,
      changed: new Set(),
      backupRoot: join(cwd, BACKUP_DIRECTORY, 't'),
      timeoutMs: 1000,
      execute: async () => ({ exitCode: 0, durationMs: 1, output: '' }),
    },
    { function: { name: 'write_file', arguments: { path: 'neu.txt', content: 'x' } } },
  );
  assert.match(result, /ohne Dateirechte/);
  assert.equal(await exists(join(cwd, 'neu.txt')), false);
});

test('Chat-Assistent ohne Kontext führt keine Befehle aus (fail-closed)', async () => {
  const cwd = await tempProject();
  const ran: string[][] = [];
  await runOllamaAgent({
    prompt: 'x',
    role: 'assistant',
    cwd,
    timeoutMs: 5000,
    fetchImpl: scripted('run_command', { command: 'docker compose down' }),
    execute: async (command) => {
      ran.push(command);
      return { exitCode: 0, durationMs: 1, output: '' };
    },
  });
  assert.deepEqual(ran, []);
});
