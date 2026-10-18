import type { Express } from 'express';
import type { Pool } from 'pg';
import { isRecord, isUuid, parseProjectSlug } from '../core/validation.js';
import { parseReferences, resolveReferences } from '../agent/chat-references.js';

const MAX_MESSAGE_CHARS = 4000;
const COLUMNS = `m.id, m.role, m.content, m.status, m.events, m.question, m.agent_id AS "agentId",
  m.agent_name AS "agentName", m.refs AS "references", m.created_at AS "createdAt"`;

async function loadMessages(pool: Pool, slug: string): Promise<unknown[]> {
  return (
    await pool.query(
      `SELECT * FROM (SELECT ${COLUMNS} FROM chat_messages m WHERE m.project_slug = $1 ORDER BY m.created_at DESC LIMIT 100) x ORDER BY "createdAt"`,
      [slug],
    )
  ).rows;
}

export function registerChatRoutes(app: Express, pool: Pool): void {
  app.get('/api/projects/:slug/chat', async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
      response.json({ messages: await loadMessages(pool, slug) });
    } catch (error) {
      next(error);
    }
  });

  // Server-Sent Events: sendet den Verlauf, sobald er sich ändert.
  app.get('/api/projects/:slug/chat/stream', (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
    response.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    let last = '';
    let busy = false;
    const push = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        const messages = await loadMessages(pool, slug);
        const snapshot = JSON.stringify(messages);
        if (snapshot !== last) {
          last = snapshot;
          response.write(`data: ${snapshot}\n\n`);
        } else {
          response.write(': ping\n\n');
        }
      } catch {
        response.end();
      } finally {
        busy = false;
      }
    };
    void push();
    const timer = setInterval(() => void push(), 1000);
    request.on('close', () => clearInterval(timer));
  });

  app.post('/api/projects/:slug/chat', async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      const content =
        isRecord(request.body) && typeof request.body.content === 'string' ? request.body.content.trim() : '';
      if (!slug || !content || content.length > MAX_MESSAGE_CHARS) {
        return void response
          .status(400)
          .json({ message: `Nachricht erforderlich (max. ${MAX_MESSAGE_CHARS} Zeichen).` });
      }
      // Optional: ein Agent des Projekts übernimmt die Anfrage (sonst der allgemeine Assistent).
      const agentId = isRecord(request.body) && isUuid(request.body.agentId) ? request.body.agentId : null;
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
        `INSERT INTO chat_messages (project_slug, role, content, status, agent_id, agent_name, refs)
         SELECT slug, 'user', $2, 'pending', $3, $4, $5::jsonb FROM projects WHERE slug = $1
         RETURNING id, role, content, status, created_at AS "createdAt"`,
        [
          slug,
          content,
          agentId,
          agent?.name ?? null,
          JSON.stringify(references.map(({ type, id, label }) => ({ type, id, label }))),
        ],
      );
      if (!result.rows[0]) return void response.status(404).json({ message: 'Projekt nicht gefunden.' });
      response.status(201).json(result.rows[0]);
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/projects/:slug/chat', async (request, response, next) => {
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
