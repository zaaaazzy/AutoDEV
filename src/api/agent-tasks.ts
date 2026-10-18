import type { Express, Response } from 'express';
import type { Pool } from 'pg';
import { isUuid, parseProjectSlug } from '../core/validation.js';
import type { Principal } from './roles.js';

/**
 * Agent-Aufgaben: gespeicherte Anweisungen je Projekt, die mit einem Klick an den Assistenten gehen.
 * Der Assistent führt sie wie eine Chat-Nachricht mit seinen Werkzeugen aus; Ergebnis und Rückfragen erscheinen im Chat.
 */
export const MAX_TITLE = 120;
export const MAX_PROMPT = 3500;

const COLUMNS = `t.id, t.title, t.prompt, t.agent_id AS "agentId",
  (SELECT a.name FROM agents a WHERE a.id = t.agent_id) AS "agentName", t.created_by AS "createdBy",
  t.run_count AS "runCount", t.last_run_at AS "lastRunAt", t.created_at AS "createdAt"`;

export function parseTask(body: unknown): { title: string; prompt: string; agentId: string | null } | string {
  const record = (body ?? {}) as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';
  if (!title || title.length > MAX_TITLE) return `Titel erforderlich (max. ${MAX_TITLE} Zeichen).`;
  if (!prompt || prompt.length > MAX_PROMPT) return `Anweisung erforderlich (max. ${MAX_PROMPT} Zeichen).`;
  if (record.agentId !== undefined && record.agentId !== null && !isUuid(record.agentId)) return 'Ungültiger Agent.';
  return { title, prompt, agentId: isUuid(record.agentId) ? record.agentId : null };
}

/** Der gewählte Agent muss zum Projekt gehören. */
async function agentInProject(pool: Pool, agentId: string | null, slug: string): Promise<boolean> {
  if (!agentId) return true;
  return !!(await pool.query('SELECT 1 FROM agents WHERE id = $1 AND project_slug = $2', [agentId, slug])).rows[0];
}

/** Nachricht an den Assistenten: Titel als Überschrift, damit der Verlauf zeigt, welche Aufgabe lief. */
export function taskMessage(task: { title: string; prompt: string }): string {
  return `Aufgabe „${task.title}“:\n${task.prompt}`;
}

export function registerAgentTaskRoutes(app: Express, pool: Pool): void {
  const me = (response: Response) => response.locals.principal as Principal | undefined;

  app.get('/api/projects/:slug/agent-tasks', async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
      const tasks = (
        await pool.query(
          `SELECT ${COLUMNS} FROM agent_tasks t WHERE t.project_slug = $1
            ORDER BY t.last_run_at DESC NULLS LAST, lower(t.title)`,
          [slug],
        )
      ).rows;
      response.json({ tasks });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/projects/:slug/agent-tasks', async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      const task = parseTask(request.body);
      if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
      if (typeof task === 'string') return void response.status(400).json({ message: task });
      if (!(await agentInProject(pool, task.agentId, slug))) {
        return void response.status(400).json({ message: 'Agent gehört nicht zum Projekt.' });
      }
      const row = (
        await pool.query(
          `WITH t AS (INSERT INTO agent_tasks (project_slug, title, prompt, agent_id, created_by)
             SELECT slug, $2, $3, $4, $5 FROM projects WHERE slug = $1 RETURNING *)
           SELECT ${COLUMNS} FROM t`,
          [slug, task.title, task.prompt, task.agentId, me(response)?.displayName ?? null],
        )
      ).rows[0];
      if (!row) return void response.status(404).json({ message: 'Projekt nicht gefunden.' });
      response.status(201).json(row);
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/agent-tasks/:id', async (request, response, next) => {
    try {
      const task = parseTask(request.body);
      if (!isUuid(request.params.id)) return void response.status(404).json({ message: 'Aufgabe nicht gefunden.' });
      if (typeof task === 'string') return void response.status(400).json({ message: task });
      const slug = (
        await pool.query<{ slug: string }>('SELECT project_slug AS slug FROM agent_tasks WHERE id = $1', [
          request.params.id,
        ])
      ).rows[0]?.slug;
      if (!slug) return void response.status(404).json({ message: 'Aufgabe nicht gefunden.' });
      if (!(await agentInProject(pool, task.agentId, slug))) {
        return void response.status(400).json({ message: 'Agent gehört nicht zum Projekt.' });
      }
      const row = (
        await pool.query(
          `WITH t AS (UPDATE agent_tasks SET title = $2, prompt = $3, agent_id = $4 WHERE id = $1 RETURNING *)
           SELECT ${COLUMNS} FROM t`,
          [request.params.id, task.title, task.prompt, task.agentId],
        )
      ).rows[0];
      if (!row) return void response.status(404).json({ message: 'Aufgabe nicht gefunden.' });
      response.json(row);
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/agent-tasks/:id', async (request, response, next) => {
    try {
      if (!isUuid(request.params.id)) return void response.status(404).json({ message: 'Aufgabe nicht gefunden.' });
      await pool.query('DELETE FROM agent_tasks WHERE id = $1', [request.params.id]);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  // Ein Klick: Aufgabe als Nachricht an den Assistenten des Projekts übergeben.
  app.post('/api/agent-tasks/:id/run', async (request, response, next) => {
    try {
      if (!isUuid(request.params.id)) return void response.status(404).json({ message: 'Aufgabe nicht gefunden.' });
      const task = (
        await pool.query<{ projectSlug: string; title: string; prompt: string; agentId: string | null }>(
          `UPDATE agent_tasks SET run_count = run_count + 1, last_run_at = NOW() WHERE id = $1
           RETURNING project_slug AS "projectSlug", title, prompt, agent_id AS "agentId"`,
          [request.params.id],
        )
      ).rows[0];
      if (!task) return void response.status(404).json({ message: 'Aufgabe nicht gefunden.' });
      const message = (
        await pool.query(
          `INSERT INTO chat_messages (project_slug, role, content, status, agent_id, agent_name)
           VALUES ($1, 'user', $2, 'pending', $3, (SELECT name FROM agents WHERE id = $3))
           RETURNING id, role, content, status, created_at AS "createdAt"`,
          [task.projectSlug, taskMessage(task), task.agentId],
        )
      ).rows[0];
      response.status(201).json(message);
    } catch (error) {
      next(error);
    }
  });
}
