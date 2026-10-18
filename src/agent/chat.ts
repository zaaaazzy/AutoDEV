import type { Pool } from 'pg';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { isShuttingDown } from '../core/shutdown.js';
import { sendPush } from '../core/push.js';
import { startProgress } from './chat-progress.js';
import { runAuthorAgent } from './requirements.js';
import { saveRequestDoc } from './request-doc.js';
import { type ChatReference, referenceContext } from './chat-references.js';
import { replyToIdeaComment } from '../api/idea-comments.js';
import type { RunnerOptions } from '../runner/runner.js';

const HISTORY_LIMIT = 20;
const QUESTION_MARKER = /^@@FRAGE:\s*(.+)$/m;
const QUESTION_RULE =
  'Rückfragen: Fehlt dir eine Information, ohne die du nicht sinnvoll weiterarbeiten kannst (z. B. eine Entscheidung zwischen klaren Alternativen), arbeite so weit wie möglich und stelle dann genau eine kurze Rückfrage. Beende die Antwort in diesem Fall mit einer eigenen Zeile `@@FRAGE: <deine Frage>`. Frage nicht, wenn du sinnvoll selbst entscheiden kannst.';

/** Trennt die Rückfrage (@@FRAGE-Zeile) vom übrigen Antworttext. */
export function splitQuestion(output: string): { text: string; question: string | null } {
  const question = QUESTION_MARKER.exec(output)?.[1]?.trim() || null;
  const text = output
    .replace(/^@@TASK\b.*$/gm, '')
    .replace(QUESTION_MARKER, '')
    .trim();
  return { text: text || question || 'Erledigt.', question };
}
export interface ChatAgent {
  name: string;
  role: string;
  instructions: string;
}

/** Vom Nutzer gewählter Agent: Bezeichnung und Beschreibung bestimmen, wie die Anfrage bearbeitet wird. */
export function agentIdentity(agent: ChatAgent | null): string {
  if (!agent)
    return 'Du bist der allgemeine Assistent dieses Projekts im Dev Log. Beantworte Fragen knapp und auf Deutsch.';
  return [
    `Du übernimmst diese Anfrage als Agent „${agent.name}“ dieses Projekts im Dev Log. Antworte knapp und auf Deutsch.`,
    agent.instructions.trim() ? `## Deine Rolle und Arbeitsweise\n${agent.instructions.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildChatPrompt(
  history: { role: string; content: string }[],
  agent: ChatAgent | null = null,
  references = '',
): string {
  return [
    agentIdentity(agent),
    references,
    'Du bist der Einstiegspunkt für alle Anfragen. Sage NIE „das darf ich nicht“, „dafür habe ich kein Tool“ oder „mach das selbst“.',
    'Du bist zugleich der Problemlöser und hast erweiterte Rechte innerhalb des Projektordners: untersuche und behebe gemeldete Fehler selbst, führe passende Tests aus und verwalte Dienste mit docker compose (ps, logs, up -d, stop, start, restart, down, build) und setze Umgebungen auf (git clone, npm install --ignore-scripts). Stoppen mit "docker compose stop" oder "docker compose down" ist erlaubt. Führe Befehle mit deinem Shell-Werkzeug aus (run_command bzw. Bash) und melde ihr tatsächliches Ergebnis. Wird ein Befehl abgelehnt, nenne ihn wörtlich, statt zu behaupten, er sei gelaufen. Diagnostiziere selbst, statt den Nutzer um Ausgaben zu bitten: Dienst-Logs liegen unter ~/Library/Logs (z. B. mainty-dev-live.log, lies sie mit deinem Lese-Werkzeug), lokale Webseiten und APIs prüfst du mit WebFetch (nur localhost), laufende Prozesse und Ports mit ps und lsof -i, Container mit docker ps und docker compose logs. Hängt der Live-Modus eines Projekts, starte ihn mit `launchctl kickstart -k gui/<uid>/ch.<projekt>.dev-live` neu (uid mit `id -u`), statt Prozesse mit kill zu beenden. Änderungen und Befehle müssen im Projektkontext bleiben.',
    'Führe die Anfrage direkt selbst aus. Erstelle niemals Aufträge, schreibe niemals @@TASK-Zeilen und delegiere nicht an andere Agents. Wenn du etwas machst, nutze deine Werkzeuge und berichte anschließend konkret über die ausgeführten Schritte und das Ergebnis.',
    QUESTION_RULE,
    `## Gespräch\n${history.map((message) => `${message.role === 'user' ? 'Nutzer' : 'Assistent'}: ${message.content}`).join('\n\n')}`,
    'Arbeite jetzt selbst an der letzten Nutzernachricht. Gib keine vorgeschlagenen Auftragszeilen aus.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Answers the oldest pending chat message of a project; returns false when nothing was waiting. */
export async function processChat(
  pool: Pool,
  options: Pick<RunnerOptions, 'project' | 'cwd' | 'timeoutMs'>,
  execute: CommandExecutor = runCommand,
): Promise<boolean> {
  const claimed = (
    await pool.query<{ id: string; content: string; agentId: string | null; references: ChatReference[] }>(
      `UPDATE chat_messages SET status = 'processing', updated_at = clock_timestamp()
      WHERE id = (SELECT id FROM chat_messages WHERE project_slug = $1 AND role = 'user' AND status = 'pending'
                   ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, content, agent_id AS "agentId", refs AS "references"`,
      [options.project],
    )
  ).rows[0];
  if (!claimed) return false;
  const agent = claimed.agentId
    ? ((await pool.query<ChatAgent>('SELECT name, role, instructions FROM agents WHERE id = $1', [claimed.agentId]))
        .rows[0] ?? null)
    : null;
  const history = await pool.query<{ role: string; content: string }>(
    `SELECT role, content FROM (SELECT role, content, created_at FROM chat_messages
      WHERE project_slug = $1 AND status <> 'failed' AND NOT (role = 'assistant' AND status = 'processing') ORDER BY created_at DESC LIMIT $2) recent ORDER BY created_at`,
    [options.project, HISTORY_LIMIT],
  );
  // Antwort auf eine offene Rückfrage: dieselbe Claude-Sitzung fortsetzen, damit der Assistent den Kontext behält.
  const openQuestion = (
    await pool.query<{ question: string; sessionId: string | null }>(
      `SELECT question, session_id AS "sessionId" FROM chat_messages
        WHERE project_slug = $1 AND role = 'assistant' AND status = 'done' AND question IS NOT NULL
          AND agent_id IS NOT DISTINCT FROM $3
          AND created_at > COALESCE((SELECT max(created_at) FROM chat_messages
                                      WHERE project_slug = $1 AND role = 'user' AND id <> $2), '-infinity')
        ORDER BY created_at DESC LIMIT 1`,
      [options.project, claimed.id, claimed.agentId],
    )
  ).rows[0];
  const resume = openQuestion?.sessionId
    ? {
        sessionId: openQuestion.sessionId,
        prompt: `Antwort des Nutzers auf deine Rückfrage „${openQuestion.question}“:\n${claimed.content}\n\nArbeite damit weiter. ${QUESTION_RULE}`,
      }
    : undefined;
  const references = await referenceContext(pool, options.project, claimed.references ?? []).catch(() => '');
  const progress = await startProgress(pool, options.project, [
    'Lese die Anfrage und den Projektkontext …',
    'Analysiere die Anfrage …',
    'Prüfe die Ergebnisse …',
    'Fasse die Ergebnisse zusammen …',
  ]);
  const { exitCode, output, sessionId } = await runAuthorAgent(
    pool,
    options,
    () => buildChatPrompt(history.rows, agent, references),
    execute,
    'assistant',
    progress.update,
    resume,
    claimed.agentId,
  ).finally(progress.stop);
  if (isShuttingDown()) {
    await pool.query(`UPDATE chat_messages SET status = 'pending', updated_at = clock_timestamp() WHERE id = $1`, [
      claimed.id,
    ]);
    return true;
  }
  if (exitCode !== 0 || !output) {
    await pool.query(`UPDATE chat_messages SET status = 'failed', updated_at = clock_timestamp() WHERE id = $1`, [
      claimed.id,
    ]);
    await pool.query(
      `INSERT INTO chat_messages (project_slug, role, content, events, agent_id, agent_name)
       VALUES ($1, 'assistant', $2, $3::jsonb, $4, $5)`,
      [
        options.project,
        `Die Anfrage konnte nicht bearbeitet werden.${output ? `\n${output.slice(0, 500)}` : ''}`,
        JSON.stringify(progress.events()),
        claimed.agentId,
        agent?.name ?? null,
      ],
    );
    await saveRequestDoc(pool, options.project, {
      request: claimed.content,
      answer: output.slice(0, 2000),
      agentName: agent?.name ?? null,
      question: null,
      failed: true,
      at: new Date(),
    }).catch(() => undefined);
    await replyToIdeaComment(
      pool,
      claimed.id,
      agent?.name ?? null,
      'Ich konnte die Anweisung nicht bearbeiten. Details stehen im Chat.',
    ).catch(() => undefined);
    return true;
  }
  const { text, question } = splitQuestion(output);
  // Auslöser war ein Kommentar mit @Agent: die Antwort erscheint auch als Kommentar bei der Idee.
  await replyToIdeaComment(pool, claimed.id, agent?.name ?? null, question ? `${text}\n\n❓ ${question}` : text).catch(
    (error: unknown) => console.error('Antwort an Ideen-Kommentar fehlgeschlagen:', error),
  );
  await pool.query(`UPDATE chat_messages SET status = 'done', updated_at = clock_timestamp() WHERE id = $1`, [
    claimed.id,
  ]);
  await pool.query(
    `INSERT INTO chat_messages (project_slug, role, content, events, question, session_id, agent_id, agent_name)
     VALUES ($1, 'assistant', $2, $3::jsonb, $4, $5, $6, $7)`,
    [
      options.project,
      text,
      JSON.stringify(progress.events()),
      question,
      sessionId ?? null,
      claimed.agentId,
      agent?.name ?? null,
    ],
  );
  // Jede Anfrage samt Ergebnis landet unter Dokumentation → Anfragen.
  await saveRequestDoc(pool, options.project, {
    request: claimed.content,
    answer: text,
    agentName: agent?.name ?? null,
    question,
    failed: false,
    at: new Date(),
  }).catch((error) => console.error('Anfrage konnte nicht dokumentiert werden:', error));
  await sendPush(
    pool,
    {
      title: question
        ? `❓ Rückfrage ${agent ? `von ${agent.name}` : 'des Assistenten'} · ${options.project}`
        : `💬 ${agent?.name ?? 'Assistent'} hat geantwortet · ${options.project}`,
      body: question ?? text.replace(/\s+/g, ' ').slice(0, 160),
      url: '#dashboard',
      tag: `chat-${options.project}`,
    },
    { project: options.project },
  );
  return true;
}

/** Beantwortet wartende Chat-Nachrichten mit dem Grund, wenn das Projekt nicht arbeitsfähig ist. */
export async function rejectChat(pool: Pool, project: string, reason: string): Promise<void> {
  const pending = await pool.query<{ id: string }>(
    `UPDATE chat_messages SET status = 'failed', updated_at = clock_timestamp()
      WHERE project_slug = $1 AND role = 'user' AND status = 'pending' RETURNING id`,
    [project],
  );
  if (!pending.rowCount) return;
  await pool.query(`INSERT INTO chat_messages (project_slug, role, content) VALUES ($1, 'assistant', $2)`, [
    project,
    `Der Assistent kann nicht arbeiten: ${reason}`,
  ]);
}
