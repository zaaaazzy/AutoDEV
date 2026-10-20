import type { Router } from 'express';
import type { Pool } from 'pg';
import { isRecord, isUuid, parseProjectSlug } from '../core/validation.js';
import { parseReferences, resolveReferences } from '../agent/chat-references.js';
import { sessionStillAllowed } from './auth.js';
import { CHAT_TARGETS, chatTargetsFor } from './chat-targets.js';
import { hasRole, type Principal } from './roles.js';

const MAX_MESSAGE_CHARS = 4000;
/**
 * Eine Rückfrage gilt als beantwortet, wenn eine Antwort ausdrücklich auf sie verweist oder danach eine Nachricht an
 * denselben Agent ging (so hat der Worker sie schon immer als Antwort behandelt).
 */
export const ANSWERED = `EXISTS (SELECT 1 FROM chat_messages u
    WHERE u.project_slug = m.project_slug AND u.role = 'user'
      AND (u.reply_to = m.id OR (u.reply_to IS NULL AND u.created_at > m.created_at
                                 AND u.agent_id IS NOT DISTINCT FROM m.agent_id)))`;
const COLUMNS = `m.id, m.role, m.content, m.status, m.events, m.question, m.agent_id AS "agentId",
  m.agent_name AS "agentName", m.refs AS "references", m.created_at AS "createdAt",
  m.question_options AS "questionOptions", m.reply_to AS "replyTo",
  (m.question IS NOT NULL AND ${ANSWERED}) AS answered`;

async function loadMessages(pool: Pool, slug: string): Promise<unknown[]> {
  return (
    await pool.query(
      `SELECT * FROM (SELECT ${COLUMNS} FROM chat_messages m WHERE m.project_slug = $1 ORDER BY m.created_at DESC LIMIT 100) x ORDER BY "createdAt"`,
      [slug],
    )
  ).rows;
}

/** Wie oft ein offener Chat-Stream Sitzung und Projektfreigabe erneut prüft. */
const STREAM_RECHECK_MS = 15_000;

export function registerChatRoutes(app: Router, pool: Pool, options: { recheckMs?: number } = {}): void {
  const recheckMs = options.recheckMs ?? STREAM_RECHECK_MS;
  app.get('/projects/:slug/chat', async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
      response.json({ messages: await loadMessages(pool, slug) });
    } catch (error) {
      next(error);
    }
  });

  // Offene Rückfrage zu einem Auftrag (Express-Anfrage): wird im Auftrag angezeigt und dort direkt beantwortet.
  app.get('/development/:id/question', async (request, response, next) => {
    try {
      if (!isUuid(request.params.id)) return void response.status(404).json({ message: 'Auftrag nicht gefunden.' });
      const question = (
        await pool.query(
          `SELECT m.id, m.question, m.question_options AS "options", m.agent_name AS "agentName",
                  m.content, m.created_at AS "createdAt", m.project_slug AS "projectSlug"
             FROM chat_messages m
            WHERE m.development_id = $1 AND m.role = 'assistant' AND m.question IS NOT NULL AND NOT ${ANSWERED}
            ORDER BY m.created_at DESC LIMIT 1`,
          [request.params.id],
        )
      ).rows[0];
      response.json({ question: question ?? null });
    } catch (error) {
      next(error);
    }
  });

  // Server-Sent Events: sendet den Verlauf, sobald er sich ändert.
  app.get('/projects/:slug/chat/stream', (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
    response.set({
      'Content-Type': 'text/event-stream',
      // no-transform: Proxys (z. B. Caddy mit „encode gzip“) dürfen den Stream nicht komprimieren und damit puffern.
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    let last = '';
    let busy = false;
    // Sitzung aus dem Login (Basic Auth und Betrieb ohne Login haben keine, die später enden könnte).
    const token = response.locals.sessionToken as string | undefined;
    let checkedAt = Date.now();
    const push = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        // Logout, Deaktivierung oder entzogene Projektfreigabe beenden den Stream.
        if (token && Date.now() - checkedAt >= recheckMs) {
          checkedAt = Date.now();
          if (!(await sessionStillAllowed(pool, token, slug))) {
            clearInterval(timer);
            response.end();
            return;
          }
        }
        const messages = await loadMessages(pool, slug);
        const snapshot = JSON.stringify(messages);
        if (snapshot !== last) {
          last = snapshot;
          response.write(`data: ${snapshot}\n\n`);
        } else {
          response.write(': ping\n\n');
        }
      } catch {
        clearInterval(timer);
        response.end();
      } finally {
        busy = false;
      }
    };
    void push();
    const timer = setInterval(() => void push(), 1000);
    request.on('close', () => clearInterval(timer));
  });

  // Per @ ansprechbare System-Agents (dynamisch, je nach Recht des Benutzers).
  app.get('/projects/:slug/chat/targets', (_request, response) => {
    response.json({ targets: chatTargetsFor(response.locals.principal as Principal | undefined) });
  });

  app.post('/projects/:slug/chat', async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      const content =
        isRecord(request.body) && typeof request.body.content === 'string' ? request.body.content.trim() : '';
      if (!slug || !content || content.length > MAX_MESSAGE_CHARS) {
        return void response
          .status(400)
          .json({ message: `Nachricht erforderlich (max. ${MAX_MESSAGE_CHARS} Zeichen).` });
      }
      // System-Agent per @ (z. B. @Visionär): eigene Aktion statt Chat-Anfrage, Antwort erscheint sofort.
      const target = CHAT_TARGETS.find((entry) => isRecord(request.body) && entry.id === request.body.agentId);
      if (target) {
        const principal = response.locals.principal as Principal | undefined;
        if (!hasRole(principal, target.role)) {
          return void response.status(403).json({ message: `Für „${target.name}“ fehlt dir das Recht.` });
        }
        await pool.query(
          `INSERT INTO chat_messages (project_slug, role, content, status, agent_name) VALUES ($1, 'user', $2, 'done', $3)`,
          [slug, content, target.name],
        );
        const answer = await target.handle(pool, slug, content, principal);
        await pool.query(
          `INSERT INTO chat_messages (project_slug, role, content, agent_name) VALUES ($1, 'assistant', $2, $3)`,
          [slug, answer, target.name],
        );
        return void response.status(201).json({ handled: target.id });
      }
      // Antwort auf eine bestimmte Rückfrage: geht an denselben Agent, auch wenn inzwischen anderes im Chat stand.
      const replyTo = isRecord(request.body) && isUuid(request.body.replyTo) ? request.body.replyTo : null;
      const question = replyTo
        ? (
            await pool.query<{ agentId: string | null }>(
              `SELECT agent_id AS "agentId" FROM chat_messages
                WHERE id = $1 AND project_slug = $2 AND role = 'assistant' AND question IS NOT NULL`,
              [replyTo, slug],
            )
          ).rows[0]
        : undefined;
      if (replyTo && !question) return void response.status(400).json({ message: 'Rückfrage nicht gefunden.' });
      // Optional: ein Agent des Projekts übernimmt die Anfrage (sonst der allgemeine Assistent).
      const agentId = question
        ? question.agentId
        : isRecord(request.body) && isUuid(request.body.agentId)
          ? request.body.agentId
          : null;
      const agent = agentId
        ? (
            await pool.query<{ name: string }>('SELECT name FROM agents WHERE id = $1 AND project_slug = $2', [
              agentId,
              slug,
            ])
          ).rows[0]
        : undefined;
      if (agentId && !agent) return void response.status(400).json({ message: 'Agent gehört nicht zum Projekt.' });
      const requested = parseReferences(isRecord(request.body) ? request.body.references : undefined);
      if (typeof requested === 'string') return void response.status(400).json({ message: requested });
      const references = await resolveReferences(pool, slug, requested);
      if (!references) return void response.status(400).json({ message: 'Ein Verweis gehört nicht zum Projekt.' });
      const result = await pool.query(
        `INSERT INTO chat_messages (project_slug, role, content, status, agent_id, agent_name, refs, reply_to)
         SELECT slug, 'user', $2, 'pending', $3, $4, $5::jsonb, $6 FROM projects WHERE slug = $1
         RETURNING id, role, content, status, created_at AS "createdAt"`,
        [
          slug,
          content,
          agentId,
          agent?.name ?? null,
          JSON.stringify(references.map(({ type, id, label }) => ({ type, id, label }))),
          replyTo,
        ],
      );
      if (!result.rows[0]) return void response.status(404).json({ message: 'Projekt nicht gefunden.' });
      response.status(201).json(result.rows[0]);
    } catch (error) {
      next(error);
    }
  });

  app.delete('/projects/:slug/chat', async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
      await pool.query(`DELETE FROM chat_messages WHERE project_slug = $1 AND status <> 'processing'`, [slug]);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });
}
