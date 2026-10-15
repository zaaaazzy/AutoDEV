import type { Pool } from 'pg';
import { type CommandExecutor, runCommand } from './command.js';
import { isShuttingDown } from './shutdown.js';
import { startProgress } from './chat-progress.js';
import { runAuthorAgent } from './requirements.js';
import type { RunnerOptions } from './runner.js';

const HISTORY_LIMIT = 20;
const TASK_MARKER = '@@TASK';

export interface ChatTask {
  title: string;
  description: string;
  agent: string | null;
}

/** Splits an assistant answer into text and task lines (`@@TASK {"title":…,"description":…,"agent":…}`). */
export function parseChatReply(output: string): { text: string; tasks: ChatTask[] } {
  const tasks: ChatTask[] = [];
  const text: string[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim().startsWith(TASK_MARKER)) {
      text.push(line);
      continue;
    }
    try {
      const raw = JSON.parse(line.trim().slice(TASK_MARKER.length)) as Record<string, unknown>;
      const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 180) : '';
      if (title) {
        tasks.push({
          title,
          description: typeof raw.description === 'string' ? raw.description.trim() : '',
          agent: typeof raw.agent === 'string' && raw.agent.trim() ? raw.agent.trim() : null,
        });
      }
    } catch {
      text.push(line);
    }
  }
  return { text: text.join('\n').trim(), tasks };
}

function buildChatPrompt(history: { role: string; content: string }[], agents: { name: string; role: string }[]): string {
  return [
    'Du bist der allgemeine Assistent dieses Projekts im Dev Log. Beantworte Fragen knapp und auf Deutsch.',
    'Du bist der Einstiegspunkt für alle Anfragen. Sage NIE „das darf ich nicht“, „dafür habe ich kein Tool“ oder „mach das selbst“.',
    'Fragen zum Projekt beantwortest du selbst: lies Dateien, nutze run_command für git log/status/diff und npm ls. Zeige das Ergebnis direkt an (z. B. den Git-Verlauf als kurze Liste).',
    'Alles, was etwas verändert, installiert, testet, dokumentiert oder entwickelt, delegierst du sofort an den passenden Agent (Entwickler: Code, Installation, Fehlerbehebung; Tester: Tests; Dokumentierer/Handbuch-Autor: Doku; Problemlöser: Fehleranalyse). Gib dazu je Aufgabe genau eine eigene Zeile aus:',
    `${TASK_MARKER} {"title": "Kurztitel", "description": "Was zu tun ist", "agent": "Agentname oder null"}`,
    'Mit "agent" startet nur dieser Agent die Aufgabe. Ohne Agent (null) landet sie im Backlog und läuft später im Sprint mit allen Agents.',
    `Verfügbare Agents:\n${agents.map((agent) => `- ${agent.name} (${agent.role})`).join('\n') || '- keine'}`,
    `## Gespräch\n${history.map((message) => `${message.role === 'user' ? 'Nutzer' : 'Assistent'}: ${message.content}`).join('\n\n')}`,
    'Antworte jetzt als Assistent auf die letzte Nutzernachricht.',
  ].join('\n\n');
}

/** Answers the oldest pending chat message of a project; returns false when nothing was waiting. */
export async function processChat(
  pool: Pool,
  options: Pick<RunnerOptions, 'project' | 'cwd' | 'timeoutMs'>,
  execute: CommandExecutor = runCommand,
): Promise<boolean> {
  const claimed = (await pool.query<{ id: string }>(
    `UPDATE chat_messages SET status = 'processing', updated_at = clock_timestamp()
      WHERE id = (SELECT id FROM chat_messages WHERE project_slug = $1 AND role = 'user' AND status = 'pending'
                   ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id`,
    [options.project],
  )).rows[0];
  if (!claimed) return false;
  const [history, agents] = await Promise.all([
    pool.query<{ role: string; content: string }>(
      `SELECT role, content FROM (SELECT role, content, created_at FROM chat_messages
        WHERE project_slug = $1 AND status <> 'failed' AND NOT (role = 'assistant' AND status = 'processing') ORDER BY created_at DESC LIMIT $2) recent ORDER BY created_at`,
      [options.project, HISTORY_LIMIT]),
    pool.query<{ name: string; role: string }>(
      `SELECT name, role FROM agents WHERE project_slug = $1 AND enabled ORDER BY position`, [options.project]),
  ]);
  const stopProgress = await startProgress(pool, options.project,
    ['Lese die Anfrage und den Projektkontext …', 'Analysiere und formuliere die Antwort …', 'Prüfe Details im Projekt …', 'Fasse die Ergebnisse zusammen …']);
  const { exitCode, output } = await runAuthorAgent(pool, options, () => buildChatPrompt(history.rows, agents.rows), execute, 'assistant')
    .finally(stopProgress);
  if (isShuttingDown()) {
    await pool.query(`UPDATE chat_messages SET status = 'pending', updated_at = clock_timestamp() WHERE id = $1`, [claimed.id]);
    return true;
  }
  if (exitCode !== 0 || !output) {
    await pool.query(`UPDATE chat_messages SET status = 'failed', updated_at = clock_timestamp() WHERE id = $1`, [claimed.id]);
    await pool.query(
      `INSERT INTO chat_messages (project_slug, role, content) VALUES ($1, 'assistant', $2)`,
      [options.project, `Die Anfrage konnte nicht bearbeitet werden.${output ? `\n${output.slice(0, 500)}` : ''}`]);
    return true;
  }
  const { text, tasks } = parseChatReply(output);
  const created: { id: string; agent: string | null; text: string }[] = [];
  for (const task of tasks) {
    const agent = task.agent
      ? (await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM agents WHERE project_slug = $1 AND enabled AND lower(name) = lower($2)`, [options.project, task.agent])).rows[0]
      : undefined;
    const item = (await pool.query<{ id: string }>(
      `INSERT INTO development_items (project_slug, title, description, status, agent_id, from_chat) VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id`,
      [options.project, task.title, task.description, agent ? 'planned' : 'backlog', agent?.id ?? null])).rows[0];
    if (item) created.push({ id: item.id, agent: agent?.name ?? null, text: agent ? `An ${agent.name} übergeben.` : 'Im Backlog angelegt.' });
  }
  await pool.query(`UPDATE chat_messages SET status = 'done', updated_at = clock_timestamp() WHERE id = $1`, [claimed.id]);
  await pool.query(
    `INSERT INTO chat_messages (project_slug, role, content) VALUES ($1, 'assistant', $2)`,
    [options.project, text || (created.length ? 'Ich habe das weitergegeben:' : 'Erledigt.')]);
  for (const item of created) {
    await pool.query(
      `INSERT INTO chat_messages (project_slug, role, content, development_id, agent_name) VALUES ($1, 'assistant', $2, $3, $4)`,
      [options.project, item.text, item.id, item.agent]);
  }
  return true;
}

/** Beantwortet wartende Chat-Nachrichten mit dem Grund, wenn das Projekt nicht arbeitsfähig ist. */
export async function rejectChat(pool: Pool, project: string, reason: string): Promise<void> {
  const pending = await pool.query<{ id: string }>(
    `UPDATE chat_messages SET status = 'failed', updated_at = clock_timestamp()
      WHERE project_slug = $1 AND role = 'user' AND status = 'pending' RETURNING id`, [project]);
  if (!pending.rowCount) return;
  await pool.query(`INSERT INTO chat_messages (project_slug, role, content) VALUES ($1, 'assistant', $2)`,
    [project, `Der Assistent kann nicht arbeiten: ${reason}`]);
}
