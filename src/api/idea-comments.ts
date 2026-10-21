import type { Router, Response } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import { sendPush } from '../core/push.js';
import { isRecord, isUuid } from '../core/validation.js';
import { hasRole, type Principal } from './roles.js';

/**
 * Kommentare an Ideen mit @-Erwähnungen: Ein erwähnter Agent bekommt den Kommentar als Anweisung (über den
 * Chat-Weg des Workers) und antwortet als Kommentar; eine erwähnte Person erhält eine Push-Meldung.
 */
export const MAX_COMMENT = 4000;
export const MAX_MENTIONS = 5;
/** Platzhalter-ID für den Systemadministrator aus der .env (hat kein Benutzerkonto). */
export const SYSTEM_PERSON = 'system';

export interface Mention {
  type: 'agent' | 'user';
  id: string;
}

export interface NamedMention extends Mention {
  name: string;
}

export const COMMENT_COLUMNS = `c.id, c.ideation_id AS "ideationId", c.author, c.author_kind AS "authorKind", c.body,
  c.mentions, c.reply_to AS "replyTo", c.created_at AS "createdAt",
  (SELECT m.status FROM chat_messages m WHERE m.idea_comment_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS "agentStatus"`;

export function parseComment(body: unknown): { text: string; mentions: Mention[] } | string {
  const record = isRecord(body) ? body : {};
  const text = typeof record.body === 'string' ? record.body.trim() : '';
  if (!text || text.length > MAX_COMMENT) return `Bitte einen Kommentar eingeben (max. ${MAX_COMMENT} Zeichen).`;
  const raw = record.mentions ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_MENTIONS) return `Höchstens ${MAX_MENTIONS} Erwähnungen.`;
  const mentions: Mention[] = [];
  for (const entry of raw as unknown[]) {
    const item = isRecord(entry) ? entry : {};
    const type = item.type === 'agent' || item.type === 'user' ? item.type : null;
    const id = typeof item.id === 'string' ? item.id : '';
    if (!type || !(isUuid(id) || (type === 'user' && id === SYSTEM_PERSON))) return 'Ungültige Erwähnung.';
    if (!mentions.some((known) => known.type === type && known.id === id)) mentions.push({ type, id });
  }
  return { text, mentions };
}

/** Anweisung an den erwähnten Agent: Bezug auf die Idee, Kommentar des Menschen, Antwort als Kommentar. */
export function agentCommentPrompt(idea: { title: string }, author: string, text: string): string {
  return [
    `Kommentar von ${author} zur Idee „${idea.title}“ (die Idee hängt als Verweis an):`,
    text,
    'Bearbeite die Anweisung bzw. beantworte die Frage. Deine Antwort erscheint als Kommentar bei der Idee – schreibe sie knapp und direkt an die Person gerichtet.',
  ].join('\n\n');
}

async function resolveMentions(pool: Pool, slug: string, mentions: Mention[]): Promise<NamedMention[] | null> {
  const resolved: NamedMention[] = [];
  for (const mention of mentions) {
    if (mention.type === 'user' && mention.id === SYSTEM_PERSON) {
      resolved.push({ ...mention, name: 'Systemadministrator' });
      continue;
    }
    const row = (
      mention.type === 'agent'
        ? await pool.query<{ name: string }>(
            'SELECT name FROM agents WHERE id = $1 AND project_slug = $2 AND enabled',
            [mention.id, slug],
          )
        : await pool.query<{ name: string }>(
            `SELECT COALESCE(NULLIF(display_name, ''), username) AS name FROM users u
              WHERE id = $1 AND active AND ('admin' = ANY(roles)
                OR EXISTS (SELECT 1 FROM project_members m WHERE m.user_id = u.id AND m.project_slug = $2))`,
            [mention.id, slug],
          )
    ).rows[0];
    if (!row) return null;
    resolved.push({ ...mention, name: row.name });
  }
  return resolved;
}

export function registerIdeaCommentRoutes(app: Router, pool: Pool): void {
  const me = (response: Response) => response.locals.principal as Principal | undefined;

  /** Personen, die in Kommentaren erwähnt werden können: Administratoren und freigeschaltete Benutzer. */
  app.get('/projects/:slug/people', access({ tenant: 'project' }), async (request, response, next) => {
    try {
      const people = (
        await pool.query<{ id: string; name: string }>(
          `SELECT id, COALESCE(NULLIF(display_name, ''), username) AS name FROM users u
            WHERE active AND ('admin' = ANY(roles)
              OR EXISTS (SELECT 1 FROM project_members m WHERE m.user_id = u.id AND m.project_slug = $1))
            ORDER BY lower(COALESCE(NULLIF(display_name, ''), username))`,
          [request.params.slug ?? ''],
        )
      ).rows;
      response.json({ people: [{ id: SYSTEM_PERSON, name: 'Systemadministrator' }, ...people] });
    } catch (error) {
      next(error);
    }
  });

  app.post('/ideation/:id/comments', access({ role: 'plan', tenant: 'ideation' }), async (request, response, next) => {
    try {
      const parsed = parseComment(request.body);
      if (!isUuid(request.params.id)) return void response.status(404).json({ message: 'Idee nicht gefunden.' });
      if (typeof parsed === 'string') return void response.status(400).json({ message: parsed });
      const idea = (
        await pool.query<{ slug: string; title: string }>(
          'SELECT project_slug AS slug, title FROM ideation_items WHERE id = $1',
          [request.params.id],
        )
      ).rows[0];
      if (!idea) return void response.status(404).json({ message: 'Idee nicht gefunden.' });
      const principal = me(response);
      if (parsed.mentions.some((mention) => mention.type === 'agent') && !hasRole(principal, 'chat')) {
        return void response.status(403).json({ message: 'Agents ansprechen erfordert die Rolle „Assistent nutzen“.' });
      }
      const mentions = await resolveMentions(pool, idea.slug, parsed.mentions);
      if (!mentions) return void response.status(400).json({ message: 'Eine Erwähnung gehört nicht zum Projekt.' });
      const author = (principal?.displayName || principal?.username || 'Nutzer').slice(0, 60);
      const comment = (
        await pool.query<{ id: string }>(
          `INSERT INTO ideation_comments (ideation_id, author, author_kind, body, mentions)
           VALUES ($1, $2, 'user', $3, $4::jsonb) RETURNING id`,
          [request.params.id, author, parsed.text, JSON.stringify(mentions)],
        )
      ).rows[0];
      if (!comment) return void response.status(404).json({ message: 'Idee nicht gefunden.' });
      for (const agent of mentions.filter((mention) => mention.type === 'agent')) {
        await pool.query(
          `INSERT INTO chat_messages (project_slug, role, content, status, agent_id, agent_name, refs, idea_comment_id)
           VALUES ($1, 'user', $2, 'pending', $3, $4, $5::jsonb, $6)`,
          [
            idea.slug,
            agentCommentPrompt(idea, author, parsed.text),
            agent.id,
            agent.name,
            JSON.stringify([{ type: 'idea', id: request.params.id, label: idea.title }]),
            comment.id,
          ],
        );
      }
      for (const person of mentions.filter((mention) => mention.type === 'user')) {
        await sendPush(
          pool,
          {
            title: `💬 ${author} hat dich erwähnt · ${idea.slug}`,
            body: `${idea.title}: ${parsed.text.slice(0, 140)}`,
            url: `#ideation/${request.params.id}?project=${encodeURIComponent(idea.slug)}`,
            tag: `mention-${comment.id}`,
          },
          { self: { id: person.id === SYSTEM_PERSON ? null : person.id } },
        ).catch((error: unknown) => console.error('Erwähnung konnte nicht gemeldet werden:', error));
      }
      const item = (
        await pool.query(`SELECT ${COMMENT_COLUMNS} FROM ideation_comments c WHERE c.id = $1`, [comment.id])
      ).rows[0];
      response.status(201).json({ item });
    } catch (error) {
      next(error);
    }
  });
}

/** Nach der Antwort des Agents: Ergebnis als Kommentar unter den auslösenden Kommentar hängen. */
export async function replyToIdeaComment(
  pool: Pool,
  chatMessageId: string,
  agentName: string | null,
  text: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO ideation_comments (ideation_id, author, author_kind, body, reply_to)
     SELECT c.ideation_id, $2, 'agent', $3, c.id
       FROM chat_messages m JOIN ideation_comments c ON c.id = m.idea_comment_id
      WHERE m.id = $1`,
    [chatMessageId, (agentName ?? 'Assistent').slice(0, 60), text.slice(0, MAX_COMMENT)],
  );
}
