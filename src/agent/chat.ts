import type { Pool } from 'pg';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { isShuttingDown } from '../core/shutdown.js';
import { startProgress } from './chat-progress.js';
import { runAuthorAgent } from './requirements.js';
import type { RunnerOptions } from '../runner/runner.js';

const HISTORY_LIMIT = 20;
function buildChatPrompt(history: { role: string; content: string }[]): string {
  return [
    'Du bist der allgemeine Assistent dieses Projekts im Dev Log. Beantworte Fragen knapp und auf Deutsch.',
    'Du bist der Einstiegspunkt für alle Anfragen. Sage NIE „das darf ich nicht“, „dafür habe ich kein Tool“ oder „mach das selbst“.',
    'Du bist zugleich der Problemlöser und hast erweiterte Rechte innerhalb des Projektordners: untersuche und behebe gemeldete Fehler selbst, führe passende Tests aus und verwalte Dienste mit docker compose (ps, logs, up -d, stop, start, restart, down, build) und setze Umgebungen auf (git clone, npm install). Stoppen mit "docker compose stop" oder "docker compose down" ist erlaubt. Rufe Befehle immer mit run_command auf und melde ihr tatsächliches Ergebnis. Änderungen und Befehle müssen im Projektkontext bleiben.',
    'Führe die Anfrage direkt selbst aus. Erstelle niemals Aufträge, schreibe niemals @@TASK-Zeilen und delegiere nicht an andere Agents. Wenn du etwas machst, nutze deine Werkzeuge und berichte anschließend konkret über die ausgeführten Schritte und das Ergebnis.',
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
    await pool.query<{ id: string }>(
      `UPDATE chat_messages SET status = 'processing', updated_at = clock_timestamp()
      WHERE id = (SELECT id FROM chat_messages WHERE project_slug = $1 AND role = 'user' AND status = 'pending'
                   ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id`,
      [options.project],
    )
  ).rows[0];
  if (!claimed) return false;
  const history = await pool.query<{ role: string; content: string }>(
    `SELECT role, content FROM (SELECT role, content, created_at FROM chat_messages
      WHERE project_slug = $1 AND status <> 'failed' AND NOT (role = 'assistant' AND status = 'processing') ORDER BY created_at DESC LIMIT $2) recent ORDER BY created_at`,
    [options.project, HISTORY_LIMIT],
  );
  const progress = await startProgress(pool, options.project, [
    'Lese die Anfrage und den Projektkontext …',
    'Analysiere die Anfrage …',
    'Prüfe die Ergebnisse …',
    'Fasse die Ergebnisse zusammen …',
  ]);
  const { exitCode, output } = await runAuthorAgent(
    pool,
    options,
    () => buildChatPrompt(history.rows),
    execute,
    'assistant',
    progress.update,
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
    await pool.query(`INSERT INTO chat_messages (project_slug, role, content) VALUES ($1, 'assistant', $2)`, [
      options.project,
      `Die Anfrage konnte nicht bearbeitet werden.${output ? `\n${output.slice(0, 500)}` : ''}`,
    ]);
    return true;
  }
  const text = output.replace(/^@@TASK\b.*$/gm, '').trim() || 'Erledigt.';
  await pool.query(`UPDATE chat_messages SET status = 'done', updated_at = clock_timestamp() WHERE id = $1`, [
    claimed.id,
  ]);
  await pool.query(`INSERT INTO chat_messages (project_slug, role, content) VALUES ($1, 'assistant', $2)`, [
    options.project,
    text,
  ]);
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
