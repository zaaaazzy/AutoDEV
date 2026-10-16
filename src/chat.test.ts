import assert from 'node:assert/strict';
import test from 'node:test';
import { runOllamaAgent } from './ollama-agent.js';

test('reports concrete tool activity through the progress callback', async () => {
  const progress: string[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as { messages: { role: string }[] };
    const message = request.messages.some((entry) => entry.role === 'tool')
      ? { role: 'assistant', content: 'Status geprüft.' }
      : { role: 'assistant', content: '', tool_calls: [{ function: { name: 'run_command', arguments: { command: 'docker compose ps' } } }] };
    return new Response(JSON.stringify({ message }), { status: 200 });
  }) as unknown as typeof fetch;
  const result = await runOllamaAgent({
    prompt: 'Prüfe den Docker-Status', role: 'assistant', cwd: process.cwd(), timeoutMs: 5000, fetchImpl,
    execute: async (command) => ({ exitCode: 0, durationMs: 1, output: command.join(' ') }),
    onProgress: (message) => progress.push(message),
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(progress, ['Führe aus: docker compose ps']);
});
