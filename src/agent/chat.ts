import type { Pool } from 'pg';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { isShuttingDown } from '../core/shutdown.js';
import { startProgress } from './chat-progress.js';
import { runAuthorAgent } from './requirements.js';
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
function buildChatPrompt(history: { role: string; content: string }[]): string {
  return [
    'Du bist der allgemeine Assistent dieses Projekts im Dev Log. Beantworte Fragen knapp und auf Deutsch.',
    'Du bist der Einstiegspunkt für alle Anfragen. Sage NIE „das darf ich nicht“, „dafür habe ich kein Tool“ oder „mach das selbst“.',
    'Du bist zugleich der Problemlöser und hast erweiterte Rechte innerhalb des Projektordners: untersuche und behebe gemeldete Fehler selbst, führe passende Tests aus und verwalte Dienste mit docker compose (ps, logs, up -d, stop, start, restart, down, build) und setze Umgebungen auf (git clone, npm install --ignore-scripts). Stoppen mit "docker compose stop" oder "docker compose down" ist erlaubt. Führe Befehle mit deinem Shell-Werkzeug aus (run_command bzw. Bash) und melde ihr tatsächliches Ergebnis. Wird ein Befehl abgelehnt, nenne ihn wörtlich, statt zu behaupten, er sei gelaufen. Diagnostiziere selbst, statt den Nutzer um Ausgaben zu bitten: Dienst-Logs liegen unter ~/Library/Logs (z. B. mainty-dev-live.log, lies sie mit deinem Lese-Werkzeug), lokale Webseiten und APIs prüfst du mit WebFetch (nur localhost), laufende Prozesse und Ports mit ps und lsof -i, Container mit docker ps und docker compose logs. Hängt der Live-Modus eines Projekts, starte ihn mit `launchctl kickstart -k gui/<uid>/ch.<projekt>.dev-live` neu (uid mit `id -u`), statt Prozesse mit kill zu beenden. Änderungen und Befehle müssen im Projektkontext bleiben.',
    'Führe die Anfrage direkt selbst aus. Erstelle niemals Aufträge, schreibe niemals @@TASK-Zeilen und delegiere nicht an andere Agents. Wenn du etwas machst, nutze deine Werkzeuge und berichte anschließend konkret über die ausgeführten Schritte und das Ergebnis.',
    QUESTION_RULE,
    `## Gespräch\n${history.map((message) => `${message.role === 'user' ? 'Nutzer' : 'Assistent'}: ${message.content}`).join('\n\n')}`,
    'Arbeite jetzt selbst an der letzten Nutzernachricht. Gib keine vorgeschlagenen Auftragszeilen aus.',
  ].join('\n\n');
}

/** Answers the oldest pending chat message of a project; returns false when nothing was waiting. */
export async function processChat(
  pool: Pool,
  options: Pick<RunnerOptions, 'project' | 'cwd' | 'timeoutMs'>,
  execute: CommandExecutor = runCommand,
): Promise<boolean> {
  const claimed = (
    await pool.query<{ id: string; content: string }>(
      `UPDATE chat_messages SET status = 'processing', updated_at = clock_timestamp()
      WHERE id = (SELECT id FROM chat_messages WHERE project_slug = $1 AND role = 'user' AND status = 'pending'
                   ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, content`,
      [options.project],
    )
  ).rows[0];
  if (!claimed) return false;
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
          AND created_at > COALESCE((SELECT max(created_at) FROM chat_messages
                                      WHERE project_slug = $1 AND role = 'user' AND id <> $2), '-infinity')
        ORDER BY created_at DESC LIMIT 1`,
      [options.project, claimed.id],
    )
  ).rows[0];
  const resume = openQuestion?.sessionId
    ? {
        sessionId: openQuestion.sessionId,
        prompt: `Antwort des Nutzers auf deine Rückfrage „${openQuestion.question}“:\n${claimed.content}\n\nArbeite damit weiter. ${QUESTION_RULE}`,
      }
    : undefined;
  const progress = await startProgress(pool, options.project, [
    'Lese die Anfrage und den Projektkontext …',
    'Analysiere die Anfrage …',
    'Prüfe die Ergebnisse …',
    'Fasse die Ergebnisse zusammen …',
  ]);
  const { exitCode, output, sessionId } = await runAuthorAgent(
    pool,
    options,
    () => buildChatPrompt(history.rows),
    execute,
    'assistant',
    progress.update,
    resume,
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
      `INSERT INTO chat_messages (project_slug, role, content, events) VALUES ($1, 'assistant', $2, $3::jsonb)`,
      [
        options.project,
        `Die Anfrage konnte nicht bearbeitet werden.${output ? `\n${output.slice(0, 500)}` : ''}`,
        JSON.stringify(progress.events()),
      ],
    );
    return true;
  }
  const { text, question } = splitQuestion(output);
  await pool.query(`UPDATE chat_messages SET status = 'done', updated_at = clock_timestamp() WHERE id = $1`, [
    claimed.id,
  ]);
  await pool.query(
    `INSERT INTO chat_messages (project_slug, role, content, events, question, session_id)
     VALUES ($1, 'assistant', $2, $3::jsonb, $4, $5)`,
    [options.project, text, JSON.stringify(progress.events()), question, sessionId ?? null],
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
