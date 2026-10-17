import assert from 'node:assert/strict';
import test from 'node:test';
import { runOllamaAgent } from './ollama-agent.js';
import { splitQuestion } from './chat.js';

test('reports concrete tool activity through the progress callback', async () => {
  const progress: string[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as { messages: { role: string }[] };
    const message = request.messages.some((entry) => entry.role === 'tool')
      ? { role: 'assistant', content: 'Status geprüft.' }
      : {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'run_command', arguments: { command: 'docker compose ps' } } }],
        };
    return new Response(JSON.stringify({ message }), { status: 200 });
  }) as unknown as typeof fetch;
  const result = await runOllamaAgent({
    prompt: 'Prüfe den Docker-Status',
    role: 'assistant',
    cwd: process.cwd(),
    timeoutMs: 5000,
    fetchImpl,
    execute: async (command) => ({ exitCode: 0, durationMs: 1, output: command.join(' ') }),
    onProgress: (message) => progress.push(message),
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(progress, ['Führe aus: docker compose ps']);
});

test('splits a follow-up question from the assistant answer', () => {
  assert.deepEqual(splitQuestion('Ich habe X geprüft.\n@@FRAGE: Soll ich Y oder Z nehmen?'), {
    text: 'Ich habe X geprüft.',
    question: 'Soll ich Y oder Z nehmen?',
  });
  assert.deepEqual(splitQuestion('Erledigt: Dienst neu gestartet.'), {
    text: 'Erledigt: Dienst neu gestartet.',
    question: null,
  });
  assert.deepEqual(splitQuestion('@@FRAGE: Welcher Port?'), { text: 'Welcher Port?', question: 'Welcher Port?' });
});
