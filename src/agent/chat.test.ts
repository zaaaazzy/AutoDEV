import assert from 'node:assert/strict';
import test from 'node:test';
import { runOllamaAgent } from './ollama-agent.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireTree } from '../core/project-lock.js';
import { splitQuestion, buildChatPrompt, findOpenQuestion, loadChatHistory, processChat } from './chat.js';

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

test('Verlauf endet bei der übernommenen Nachricht und lässt wartende Nutzernachrichten weg', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [{ role: 'user', content: 'Nachricht 1' }] };
    },
  } as unknown as Parameters<typeof loadChatHistory>[0];
  const history = await loadChatHistory(pool, 'demo', 'msg-1');
  assert.deepEqual(history.rows, [{ role: 'user', content: 'Nachricht 1' }]);
  const [call] = calls;
  assert.ok(call);
  assert.deepEqual(call.params, ['demo', 20, 'msg-1']);
  const sql = call.sql.replace(/\s+/g, ' ');
  assert.match(sql, /created_at <= \(SELECT created_at FROM chat_messages WHERE id = \$3\)/);
  assert.match(sql, /\(role <> 'user' OR status NOT IN \('pending', 'processing'\) OR id = \$3\)/);
});

test('Verlauf: Antwort auf Nachricht 1 nach der schon wartenden Nachricht 2 steht davor (N1, A1, N2)', async () => {
  // Nachricht 1 (t1), Nachricht 2 wartet (t2), Antwort A1 (t3) – die Datenbank liefert nach created_at sortiert.
  const calls: string[] = [];
  const pool = {
    query: async (sql: string) => {
      calls.push(sql.replace(/\s+/g, ' '));
      return {
        rows: [
          { id: 'n1', role: 'user', content: 'Nachricht 1' },
          { id: 'n2', role: 'user', content: 'Nachricht 2' },
          { id: 'a1', role: 'assistant', content: 'A1' },
        ],
      };
    },
  } as unknown as Parameters<typeof loadChatHistory>[0];
  const history = await loadChatHistory(pool, 'demo', 'n2');
  assert.deepEqual(history.rows, [
    { role: 'user', content: 'Nachricht 1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'Nachricht 2' },
  ]);
  const [sql] = calls;
  assert.ok(sql);
  // Zeitfilter nur für Nutzernachrichten; die übernommene Nachricht fällt nie aus dem Limit; Sitzung bleibt das Projekt.
  assert.match(sql, /\(role <> 'user' OR created_at <= \(SELECT created_at FROM chat_messages WHERE id = \$3\)\)/);
  assert.match(sql, /ORDER BY id = \$3 DESC, created_at DESC LIMIT \$2/);
  assert.match(sql, /project_slug = \$1/);
});

/** Wertet die Zeitbedingungen der Rückfrage-Suche auf einem kleinen Datenbestand aus – nur die, die im SQL stehen. */
function questionPool(messages: { id: string; role: string; question?: string; at: number }[]) {
  return {
    query: async (sql: string, params: unknown[]) => {
      const text = sql.replace(/\s+/g, ' ');
      const beforeClaimed = text.includes('created_at < (SELECT created_at FROM chat_messages WHERE id = $2)');
      const afterLastUser = text.includes('created_at > COALESCE(');
      const claimedAt = messages.find((message) => message.id === params[1])?.at ?? 0;
      const otherUsers = messages.filter((m) => m.role === 'user' && m.id !== params[1]);
      const lastUser = Math.max(-Infinity, ...otherUsers.map((m) => m.at));
      const rows = messages
        .filter((m) => m.role === 'assistant' && m.question)
        .filter((m) => !beforeClaimed || m.at < claimedAt)
        .filter((m) => !afterLastUser || m.at > lastUser)
        .sort((a, b) => b.at - a.at)
        .slice(0, 1)
        .map((m) => ({ id: m.id, question: m.question, sessionId: `session-${m.id}` }));
      return { rows };
    },
  } as unknown as Parameters<typeof findOpenQuestion>[0];
}

test('Rückfrage nach der übernommenen Nachricht setzt die Sitzung nicht fort', async () => {
  // N1 (t1), N2 wartet (t2), A1 mit @@FRAGE (t3): N2 wurde vor der Rückfrage geschrieben.
  const pool = questionPool([
    { id: 'n1', role: 'user', at: 1 },
    { id: 'n2', role: 'user', at: 2 },
    { id: 'a1', role: 'assistant', question: 'Welche Variante?', at: 3 },
  ]);
  assert.equal(await findOpenQuestion(pool, 'demo', { id: 'n2', agentId: null, replyTo: null }), undefined);
});

test('Rückfrage vor der übernommenen Nachricht setzt die Sitzung weiterhin fort', async () => {
  const pool = questionPool([
    { id: 'n1', role: 'user', at: 1 },
    { id: 'a1', role: 'assistant', question: 'Welche Variante?', at: 2 },
    { id: 'n2', role: 'user', at: 3 },
  ]);
  const open = await findOpenQuestion(pool, 'demo', { id: 'n2', agentId: null, replyTo: null });
  assert.deepEqual(open, { id: 'a1', question: 'Welche Variante?', sessionId: 'session-a1' });
});

test('Rückfrage mit gleichem Zeitstempel wie die übernommene Nachricht zählt nicht', async () => {
  const pool = questionPool([
    { id: 'n1', role: 'user', at: 1 },
    { id: 'a1', role: 'assistant', question: 'Welche Variante?', at: 2 },
    { id: 'n2', role: 'user', at: 2 },
  ]);
  assert.equal(await findOpenQuestion(pool, 'demo', { id: 'n2', agentId: null, replyTo: null }), undefined);
});

/**
 * Antwort auf eine offene Rückfrage (Sitzung wird fortgesetzt), optional mit Verweis auf einen Auftrag und bei
 * belegtem Ordner. Liefert den Befehl, den der Executor für den Agent-Lauf erhält.
 */
async function resumedRun(options: { withReference: boolean; busy: boolean }): Promise<string> {
  const orderId = '11111111-1111-4111-8111-111111111111';
  const pool = {
    query: async (sql: string) => {
      const text = sql.replace(/\s+/g, ' ');
      if (text.startsWith("UPDATE chat_messages SET status = 'processing'")) {
        return {
          rows: [
            {
              id: 'n2',
              content: 'Nimm Variante B.',
              agentId: 'agent-1',
              references: options.withReference ? [{ type: 'order', id: orderId, label: 'Login' }] : [],
              ideaCommentId: null,
              replyTo: null,
              origin: 'chat',
              taskRunId: null,
            },
          ],
        };
      }
      if (text.includes('session_id AS "sessionId"')) {
        return { rows: [{ id: 'a1', question: 'Welche Variante?', sessionId: 'session-a1' }] };
      }
      if (text.includes('FROM development_items d LEFT JOIN bugs b')) {
        return { rows: [{ title: 'Login', status: 'in_progress', description: 'Login reparieren', untrusted: false }] };
      }
      if (text.includes('command, allowed_commands')) {
        return { rows: [{ instructions: '', command: ['claude', '-p'], allowedCommands: null, fileScope: [] }] };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Parameters<typeof processChat>[0];
  const cwd = mkdtempSync(join(tmpdir(), 'chat-resume-'));
  const release = options.busy ? await acquireTree(cwd) : undefined;
  const commands: string[][] = [];
  try {
    await processChat(pool, { project: 'demo', cwd, timeoutMs: 5000 }, async (command) => {
      commands.push(command);
      return { exitCode: 0, durationMs: 1, output: 'Erledigt.' };
    });
  } finally {
    release?.();
  }
  const run = commands.find((command) => command.includes('--resume'));
  assert.ok(run, 'Agent-Lauf setzt die Sitzung fort');
  return run.join('\n');
}

test('Fortgesetzte Sitzung erhält die Verweise des Nutzers', async () => {
  const prompt = await resumedRun({ withReference: true, busy: false });
  assert.match(prompt, /Antwort des Nutzers auf deine Rückfrage „Welche Variante\?“/);
  assert.match(prompt, /## Verweise des Nutzers/);
  assert.match(prompt, /Auftrag „Login“/);
  assert.doesNotMatch(prompt, /Du kannst nur lesen/);
});

test('Fortgesetzte Sitzung erhält bei belegtem Ordner den Nur-lesen-Hinweis', async () => {
  const prompt = await resumedRun({ withReference: false, busy: true });
  assert.match(prompt, /Du kannst nur lesen und antworten/);
  assert.doesNotMatch(prompt, /Verweise des Nutzers/);
});

test('Fortgesetzte Sitzung ohne Verweis und bei freiem Ordner bleibt ohne beide Zusätze', async () => {
  const prompt = await resumedRun({ withReference: false, busy: false });
  assert.match(prompt, /Antwort des Nutzers auf deine Rückfrage/);
  assert.doesNotMatch(prompt, /Verweise des Nutzers/);
  assert.doesNotMatch(prompt, /Du kannst nur lesen/);
});
