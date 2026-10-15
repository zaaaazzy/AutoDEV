import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BACKUP_DIRECTORY, executeTool, runOllamaAgent, type ToolContext } from './ollama-agent.js';

async function project(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ollama-agent-'));
  await writeFile(join(directory, 'a.txt'), 'alt\n');
  await writeFile(join(directory, '.env'), 'SECRET=1\n');
  return directory;
}

const context = (cwd: string, canWrite: boolean): ToolContext => ({
  cwd, canWrite, changed: new Set(), backupRoot: join(cwd, BACKUP_DIRECTORY, 't'), timeoutMs: 1000,
  execute: async (command) => ({ exitCode: 0, durationMs: 1, output: `ran ${command.join(' ')}` }),
});
const call = (name: string, args: Record<string, unknown>) => ({ function: { name, arguments: args } });

function scriptedFetch(messages: unknown[]): { fetchImpl: typeof fetch; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ message: messages.shift() }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

test('tools stay inside the project and hide secrets', async () => {
  const cwd = await project();
  const read = context(cwd, false);
  assert.match(await executeTool(read, call('read_file', { path: 'a.txt' })), /alt/);
  assert.match(await executeTool(read, call('read_file', { path: '../etc/passwd' })), /außerhalb/);
  assert.match(await executeTool(read, call('read_file', { path: '.env' })), /nicht erlaubt/);
  assert.doesNotMatch(await executeTool(read, call('list_files', { path: '.' })), /\.env/);
  assert.match(await executeTool(read, call('write_file', { path: 'b.txt', content: 'x' })), /nicht erlaubt/);
  assert.match(await executeTool(read, call('run_command', { command: 'npm test' })), /nicht erlaubt/);

  const outside = await mkdtemp(join(tmpdir(), 'outside-'));
  await symlink(outside, join(cwd, 'link'));
  assert.match(await executeTool(context(cwd, true), call('write_file', { path: 'link/x.txt', content: 'x' })), /außerhalb/);
  assert.deepEqual(await readdir(outside), []);
});

test('the developer may write with backup, but only run allowed commands', async () => {
  const cwd = await project();
  const dev = context(cwd, true);
  assert.match(await executeTool(dev, call('write_file', { path: 'a.txt', content: 'neu\n' })), /geschrieben/);
  assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'neu\n');
  assert.equal(await readFile(join(dev.backupRoot, 'a.txt'), 'utf8'), 'alt\n');
  assert.match(await executeTool(dev, call('replace_in_file', { path: 'a.txt', old_text: 'neu', new_text: 'neuer' })), /Ersetzt/);
  assert.match(await executeTool(dev, call('replace_in_file', { path: 'a.txt', old_text: 'fehlt', new_text: 'x' })), /0-mal/);
  assert.match(await executeTool(dev, call('run_command', { command: 'npm run build' })), /ran npm run build/);
  for (const command of ['rm -rf /', 'npm test; rm -rf /', 'git diff --output=x', 'curl http://x', 'npm install -g foo', 'npm install git+https://x/y.git', 'npm install foo; ls', 'npx evil', 'npm install --prefix /tmp x']) {
    assert.match(await executeTool(dev, call('run_command', { command })), /nicht erlaubt/);
  }
  for (const command of ['npm install', 'npm install express pug@^3.0.0 --save', 'npm install -D @types/node', 'npm ls --depth=0', 'node --check server.js', 'npx --no-install tsc --noEmit']) {
    assert.match(await executeTool(dev, call('run_command', { command })), /Exit-Code/);
  }
  assert.deepEqual([...dev.changed], ['a.txt']);
  await mkdir(join(cwd, 'sub'));
});

test('agent loop executes tool calls and returns the final answer with changed files', async () => {
  const cwd = await project();
  const { fetchImpl, bodies } = scriptedFetch([
    { role: 'assistant', content: '', tool_calls: [call('write_file', { path: 'neu.txt', content: 'hallo' })] },
    { role: 'assistant', content: 'Datei angelegt.' },
  ]);
  const result = await runOllamaAgent({ prompt: 'Lege neu.txt an', role: 'developer', cwd, timeoutMs: 5000, fetchImpl });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Datei angelegt\.[\s\S]*- neu\.txt/);
  assert.equal(await readFile(join(cwd, 'neu.txt'), 'utf8'), 'hallo');
  assert.equal((bodies[1] as { messages: { role: string }[] }).messages.at(-1)?.role, 'tool');
});

test('accepts a developer answer that proves the order is already implemented', async () => {
  const cwd = await project();
  const done = scriptedFetch([{ role: 'assistant', content: 'KEINE ÄNDERUNG NÖTIG: src/a.ts erfüllt alle Kriterien.' }]);
  const result = await runOllamaAgent({ prompt: 'x', role: 'developer', cwd, timeoutMs: 5000, fetchImpl: done.fetchImpl });
  assert.equal(result.exitCode, 0);
});

test('fails honestly: no changes by developer, unreachable model, empty answer', async () => {
  const cwd = await project();
  const idle = scriptedFetch([{ role: 'assistant', content: 'Fertig.' }]);
  const noChange = await runOllamaAgent({ prompt: 'x', role: 'developer', cwd, timeoutMs: 5000, fetchImpl: idle.fetchImpl });
  assert.equal(noChange.exitCode, 1);
  assert.match(noChange.output, /keine Dateien geändert/);

  const reader = scriptedFetch([{ role: 'assistant', content: 'Analyse' }]);
  assert.equal((await runOllamaAgent({ prompt: 'x', role: 'author', cwd, timeoutMs: 5000, fetchImpl: reader.fetchImpl })).exitCode, 0);

  const empty = scriptedFetch([{ role: 'assistant', content: '  ' }]);
  assert.equal((await runOllamaAgent({ prompt: 'x', role: 'author', cwd, timeoutMs: 5000, fetchImpl: empty.fetchImpl })).exitCode, 1);

  const broken = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  const down = await runOllamaAgent({ prompt: 'x', role: 'author', cwd, timeoutMs: 5000, fetchImpl: broken });
  assert.equal(down.exitCode, 1);
  assert.match(down.output, /nicht erreichbar/);

  const loop = scriptedFetch(Array.from({ length: 3 }, () => ({ role: 'assistant', content: '', tool_calls: [call('list_files', { path: '.' })] })));
  const capped = await runOllamaAgent({ prompt: 'x', role: 'author', cwd, timeoutMs: 5000, fetchImpl: loop.fetchImpl, maxTurns: 2 });
  assert.match(capped.output, /Maximale Anzahl/);
});
