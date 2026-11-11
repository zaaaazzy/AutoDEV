import type { Pool } from 'pg';
import { DEVELOPMENT_STATUS, SPRINT_STATUS } from '../core/status.js';

/**
 * Express-Anfragen: Jede Anfrage im Dashboard-Chat (auch Aktionen wie „Tests ausführen“) erscheint als eigener,
 * ungeplanter Auftrag im aktiven Sprint. Antworten auf Rückfragen gehören zum selben Auftrag; die Beschreibung fasst
 * den ganzen Verlauf zusammen. Der Worker führt Express-Aufträge nie als normalen Auftrag aus – sie entstehen und
 * enden im Chat.
 */
export const EXPRESS_KIND = 'express';
const TASK = /^Aufgabe „([^“]+)“:\s*/;
const TITLE_MAX = 180;
const STEP_MAX = 700;

export interface ExpressMessage {
  role: 'user' | 'assistant';
  content: string;
  question: string | null;
  status: string;
  agentName: string | null;
  createdAt: Date;
}

/** Titel des Auftrags: Name der Aktion bzw. der Anfang der Anfrage. */
export function expressTitle(request: string): string {
  const subject = (request.match(TASK)?.[1] ?? request).replace(/\s+/g, ' ').trim() || 'Anfrage';
  return subject.length > TITLE_MAX ? `${subject.slice(0, TITLE_MAX - 1)}…` : subject;
}

const time = (date: Date): string => date.toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' });
const clip = (text: string, max = STEP_MAX): string => {
  const plain = text.trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
};
const quote = (text: string): string =>
  clip(text)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

/** Beschreibung des Auftrags: Anfrage, Verlauf aller Nachrichten und das letzte Ergebnis. */
export function expressSummary(messages: readonly ExpressMessage[]): string {
  const first = messages.find((message) => message.role === 'user');
  const answers = messages.filter((message) => message.role === 'assistant');
  const last = answers.at(-1);
  const by = last?.agentName ?? first?.agentName ?? 'Assistent';
  const request = (first?.content ?? '').replace(TASK, (_match, title: string) => `**Aufgabe „${title}“**\n\n`).trim();
  const steps = messages.map((message) => {
    if (message.role === 'user') {
      const who = message === first ? 'Anfrage' : 'Antwort von dir';
      return `**${time(message.createdAt)} · ${who}**\n${quote(message.content)}`;
    }
    const failed = message.content.startsWith('Die Anfrage konnte nicht bearbeitet werden');
    const head = `**${time(message.createdAt)} · ${message.agentName ?? 'Assistent'}${failed ? ' (fehlgeschlagen)' : ''}**`;
    // Leerzeile vor der Rückfrage, sonst zieht Markdown sie ins Zitat.
    const body = `${head}\n${quote(message.content)}`;
    return message.question ? `${body}\n\n❓ **Rückfrage:** ${message.question}` : body;
  });
  return [
    `**⚡ Express-Anfrage aus dem Dashboard** – ungeplant in den Sprint aufgenommen. **Übernommen von:** ${by}`,
    `## Anfrage\n${request || '_Keine Anfrage._'}`,
    `## Verlauf\n${steps.join('\n\n')}`,
    last
      ? last.question
        ? `## Offen\n❓ ${last.question}\n\nAntwort im Dashboard-Chat geben – der Assistent arbeitet dann weiter.`
        : `## Ergebnis\n${last.content.trim()}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 60_000);
}

/**
 * Auftrag zu einer eben übernommenen Chat-Anfrage: Antwort auf eine Rückfrage → Auftrag der ursprünglichen Anfrage,
 * sonst ein neuer Express-Auftrag im aktiven Sprint (ohne aktiven Sprint im Backlog). Liefert dessen ID.
 */
export async function openExpressOrder(
  pool: Pool,
  project: string,
  message: { id: string; content: string },
  /** Rückfrage, auf die diese Nachricht antwortet (null = neue Anfrage). */
  questionId: string | null,
): Promise<string> {
  // Schon angelegt (die Anfrage läuft nach einer Unterbrechung erneut): denselben Auftrag weiterführen.
  const own = (
    await pool.query<{ id: string | null }>(`SELECT development_id AS id FROM chat_messages WHERE id = $1`, [
      message.id,
    ])
  ).rows[0]?.id;
  const previous = own
    ? own
    : questionId
      ? (
          await pool.query<{ id: string }>(
            `SELECT d.id FROM chat_messages m JOIN development_items d ON d.id = m.development_id
            WHERE m.id = $1 AND m.project_slug = $2 AND d.kind = '${EXPRESS_KIND}'`,
            [questionId, project],
          )
        ).rows[0]?.id
      : undefined;
  let id = previous;
  if (id) {
    await pool.query(
      `UPDATE development_items SET status = '${DEVELOPMENT_STATUS.inProgress}', action_todo = NULL, failure = NULL, updated_at = NOW()
        WHERE id = $1`,
      [id],
    );
  } else {
    id = (
      await pool.query<{ id: string }>(
        `INSERT INTO development_items (project_slug, title, description, status, priority, kind, auto_run, sprint_id)
         VALUES ($1, $2, $3, '${DEVELOPMENT_STATUS.inProgress}', 'high', '${EXPRESS_KIND}', FALSE,
                 (SELECT id FROM sprints WHERE project_slug = $1 AND status = '${SPRINT_STATUS.active}' ORDER BY created_at LIMIT 1))
         RETURNING id`,
        [
          project,
          expressTitle(message.content),
          `**⚡ Express-Anfrage aus dem Dashboard** – der Assistent arbeitet daran.\n\n## Anfrage\n${message.content}`,
        ],
      )
    ).rows[0]?.id;
    if (!id) throw new Error('Express-Auftrag wurde nicht angelegt.');
  }
  await pool.query(`UPDATE chat_messages SET development_id = $2 WHERE id = $1`, [message.id, id]);
  return id;
}

/** Nach der Antwort: Verlauf zusammenfassen und den Status setzen (erledigt, Rückfrage offen oder fehlgeschlagen). */
export async function closeExpressOrder(pool: Pool, orderId: string): Promise<void> {
  const messages = (
    await pool.query<ExpressMessage>(
      `SELECT role, content, question, status, agent_name AS "agentName", created_at AS "createdAt"
         FROM chat_messages WHERE development_id = $1 ORDER BY created_at`,
      [orderId],
    )
  ).rows;
  const last = messages.filter((message) => message.role === 'assistant').at(-1);
  const failed = !last || last.content.startsWith('Die Anfrage konnte nicht bearbeitet werden');
  const description = expressSummary(messages);
  if (failed) {
    await pool.query(
      `UPDATE development_items SET status = '${DEVELOPMENT_STATUS.blocked}', description = $2, failure = $3, updated_at = NOW() WHERE id = $1`,
      [
        orderId,
        description,
        `Agent „${last?.agentName ?? 'Assistent'}“ scheiterte: ${last?.content ?? 'keine Antwort'}`,
      ],
    );
  } else if (last.question) {
    await pool.query(
      `UPDATE development_items SET status = '${DEVELOPMENT_STATUS.blocked}', description = $2, action_todo = $3, updated_at = NOW()
        WHERE id = $1`,
      [orderId, description, `Rückfrage: ${clip(last.question, 300)} – im Dashboard-Chat antworten`],
    );
  } else {
    await pool.query(
      `UPDATE development_items SET status = '${DEVELOPMENT_STATUS.done}', description = $2, completed_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [orderId, description],
    );
  }
}
