import assert from 'node:assert/strict';
import test from 'node:test';
import { runOllamaAgent } from './ollama-agent.js';
import { splitQuestion, buildChatPrompt } from './chat.js';

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
    options: [],
  });
  assert.deepEqual(splitQuestion('Erledigt: Dienst neu gestartet.'), {
    text: 'Erledigt: Dienst neu gestartet.',
    question: null,
    options: [],
  });
  assert.deepEqual(splitQuestion('@@FRAGE: Welcher Port?'), {
    text: 'Welcher Port?',
    question: 'Welcher Port?',
    options: [],
  });
});

test('Rückfrage mit Antwortmöglichkeiten zum Anklicken (höchstens 4, ohne Dubletten)', () => {
  assert.deepEqual(
    splitQuestion(
      'Ich brauche eine Freigabe.\n@@FRAGE: Darf ich npm audit ausführen?\n@@OPTIONEN: Ja | Nein, nur lesen | Ja | a | b | c',
    ),
    {
      text: 'Ich brauche eine Freigabe.',
      question: 'Darf ich npm audit ausführen?',
      options: ['Ja', 'Nein, nur lesen', 'a', 'b'],
    },
  );
  // Ohne Rückfrage keine Optionen.
  assert.deepEqual(splitQuestion('Fertig.\n@@OPTIONEN: A | B').options, []);
});

test('Gewählter Agent übernimmt mit Bezeichnung und Beschreibung', () => {
  const prompt = buildChatPrompt([{ role: 'user', content: 'Prüfe die Tests' }], {
    name: 'Tester',
    role: 'tester',
    instructions: 'Teste gründlich, ändere keinen Code.',
  });
  assert.match(prompt, /als Agent „Tester“/);
  assert.match(prompt, /Teste gründlich, ändere keinen Code\./);
  assert.match(buildChatPrompt([]), /allgemeine Assistent/);
});
