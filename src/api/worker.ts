import { PHASE_SQL_ORDER } from '../core/workflow-phases.js';
import { ANSWERED } from './chat-routes.js';
import type { Express } from 'express';
import { cpus, loadavg } from 'node:os';
import type { Pool } from 'pg';
import { isUuid, parseProjectSlug } from '../core/validation.js';

export async function beatHeartbeat(
  pool: Pool,
  project: string,
  intervalSeconds: number,
  lastError: string | null = null,
  startup = false,
): Promise<void> {
  const cpuPercent = Math.min(100, Math.round((loadavg()[0] / cpus().length) * 100));
  await pool.query(
    `INSERT INTO worker_heartbeats (project_slug, pid, interval_seconds, last_error, cpu_percent)
     VALUES ($1, $2, $3, $4, $6)
     ON CONFLICT (project_slug) DO UPDATE
       SET last_seen = NOW(), pid = $2, interval_seconds = $3, last_error = $4, cpu_percent = $6,
           started_at = CASE WHEN $5 THEN NOW() ELSE worker_heartbeats.started_at END`,
    [project, process.pid, intervalSeconds, lastError, startup, cpuPercent],
  );
}

export const MAX_AGENTS_LIMIT = 8;
export const DEFAULT_MAX_AGENTS = 2;

export async function readMaxAgents(pool: Pool): Promise<number> {
  const row = (
    await pool.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'max_concurrent_agents'`)
  ).rows[0];
  const value = Number(row?.value);
  return Number.isInteger(value) && value >= 1 && value <= MAX_AGENTS_LIMIT ? value : DEFAULT_MAX_AGENTS;
}

/** Kennung des Dashboard-Assistenten in der Agent-Liste der Kopfzeile. */
export const ASSISTANT_AGENT_ID = 'assistant';
/** Der Visionär ist ebenfalls kein Workflow-Agent; aktiv, solange ein Lauf angefragt ist oder läuft. */
export const VISIONARY_AGENT_ID = 'visionary';

export function registerWorkerRoutes(app: Express, pool: Pool): void {
  app.get('/api/settings', async (_request, response, next) => {
    try {
      response.json({ maxConcurrentAgents: await readMaxAgents(pool), limit: MAX_AGENTS_LIMIT });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/settings', async (request, response, next) => {
    try {
      const value = Number((request.body as { maxConcurrentAgents?: unknown } | undefined)?.maxConcurrentAgents);
      if (!Number.isInteger(value) || value < 1 || value > MAX_AGENTS_LIMIT) {
        response.status(400).json({ message: `Die Anzahl muss zwischen 1 und ${MAX_AGENTS_LIMIT} liegen.` });
        return;
      }
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ('max_concurrent_agents', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [String(value)],
      );
      response.json({ maxConcurrentAgents: value, limit: MAX_AGENTS_LIMIT });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/agent-status', async (_request, response, next) => {
    try {
      const allowed = response.locals.allowedProjects as Set<string> | null | undefined;
      const visible = allowed ? [...allowed] : null;
      const projects = (
        await pool.query(
          `SELECT p.slug, p.name, h.last_error AS "lastError",
                COALESCE(EXTRACT(EPOCH FROM (NOW() - h.last_seen)) <= 60, FALSE) AS online
           FROM projects p LEFT JOIN worker_heartbeats h ON h.project_slug = p.slug
          WHERE $1::text[] IS NULL OR p.slug = ANY($1) ORDER BY p.name`,
          [visible],
        )
      ).rows;
      const running = (
        await pool.query(
          `SELECT r.project_slug AS project, d.title, r.started_at AS "startedAt"
           FROM agent_runs r JOIN development_items d ON d.id = r.development_id
          WHERE r.status = 'running' AND ($1::text[] IS NULL OR r.project_slug = ANY($1)) ORDER BY r.started_at`,
          [visible],
        )
      ).rows;
      response
        .set('Cache-Control', 'no-store')
        .json({ maxConcurrentAgents: await readMaxAgents(pool), projects, running });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/projects/:slug/agents/:id/activity', async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug);
      const id = String(request.params.id);
      if (!slug || !isUuid(id)) {
        response.status(400).json({ message: 'Ungültige Anfrage.' });
        return;
      }
      const rows = (
        await pool.query(
          `SELECT st.id, st.status AS "stepStatus", st.duration_ms AS "durationMs", st.output, st.progress, st.events, r.started_at AS "startedAt",
                d.id AS "orderId", d.title AS "orderTitle", d.description AS "orderDescription",
                d.status AS "orderStatus", d.priority AS "orderPriority",
                s.id AS "sprintId", s.name AS "sprintName", s.goal AS "sprintGoal", s.status AS "sprintStatus",
                to_char(s.start_date, 'YYYY-MM-DD') AS "sprintStart", to_char(s.end_date, 'YYYY-MM-DD') AS "sprintEnd"
           FROM agent_run_steps st
           JOIN agent_runs r ON r.id = st.run_id
           JOIN development_items d ON d.id = r.development_id
           LEFT JOIN sprints s ON s.id = d.sprint_id
          WHERE st.agent_id = $1 AND r.project_slug = $2
          ORDER BY r.started_at DESC, st.position DESC LIMIT 50`,
          [id, slug],
        )
      ).rows;
      const upcoming = (
        await pool.query(
          `SELECT d.id, d.title, d.description, d.status, d.priority, s.name AS "sprintName"
           FROM development_items d
           JOIN agents a ON a.id = $1 AND a.project_slug = d.project_slug
           LEFT JOIN sprints s ON s.id = d.sprint_id
          WHERE d.project_slug = $2 AND d.status = 'planned'
            AND (d.agent_id = a.id OR (d.agent_id IS NULL AND s.status = 'active' AND a.enabled
                 AND NOT (a.role = 'author' AND d.ideation_id IS NOT NULL)))
          ORDER BY d.created_at LIMIT 50`,
          [id, slug],
        )
      ).rows;
      response.set('Cache-Control', 'no-store').json({ activity: rows, upcoming });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/projects/:slug/agents/:id/cancel', async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug);
      if (!slug) {
        response.status(400).json({ message: 'Ungültiges Projekt.' });
        return;
      }
      const result = await pool.query(
        `UPDATE agent_run_steps st SET cancel_requested = TRUE
           FROM agent_runs r, agents a
          WHERE r.id = st.run_id AND a.id = st.agent_id AND a.project_slug = $1 AND a.id::text = $2
            AND st.status = 'running' AND r.status = 'running'`,
        [slug, request.params.id],
      );
      if (!result.rowCount) {
        response.status(404).json({ message: 'Dieser Agent läuft gerade nicht.' });
        return;
      }
      response.status(202).json({ cancelling: true });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/projects/:slug/worker', async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug);
      if (!slug) {
        response.status(400).json({ message: 'Ungültiges Projekt.' });
        return;
      }
      const beat =
        (
          await pool.query(
            `SELECT EXTRACT(EPOCH FROM (NOW() - last_seen))::int AS "ageSeconds", last_seen AS "lastSeen",
                started_at AS "startedAt", pid, interval_seconds AS "intervalSeconds", last_error AS "lastError",
                cpu_percent AS "cpuPercent"
           FROM worker_heartbeats WHERE project_slug = $1`,
            [slug],
          )
        ).rows[0] ?? null;
      const running = (
        await pool.query(
          `SELECT d.id, d.title, r.started_at AS "startedAt"
           FROM agent_runs r JOIN development_items d ON d.id = r.development_id
          WHERE r.project_slug = $1 AND r.status = 'running' ORDER BY r.started_at`,
          [slug],
        )
      ).rows;
      const agents = (
        await pool.query(
          `SELECT a.id, a.name, a.phase, a.role, s.name AS "sprintName", d.title AS "orderTitle",
                (st.id IS NOT NULL) AS active
           FROM agents a
           LEFT JOIN LATERAL (
             SELECT st.id, r.development_id FROM agent_run_steps st JOIN agent_runs r ON r.id = st.run_id
              WHERE st.agent_id = a.id AND st.status = 'running' AND r.status = 'running' LIMIT 1
           ) st ON TRUE
           LEFT JOIN development_items d ON d.id = st.development_id
           LEFT JOIN sprints s ON s.id = d.sprint_id
          WHERE a.project_slug = $1 AND a.enabled
          ORDER BY ${PHASE_SQL_ORDER.replace('CASE phase', 'CASE a.phase')}, a.position`,
          [slug],
        )
      ).rows;
      // Aufträge in Entstehung: Ideen, aus denen der Auftragsautor gerade einen Auftrag schreibt (oder schreiben wird).
      const drafts = (
        await pool.query<{
          id: string;
          title: string;
          status: string;
          progress: string | null;
          agent: string | null;
          startedAt: string | null;
        }>(
          `SELECT id, title, status, progress, progress_agent AS agent, drafting_started_at AS "startedAt"
             FROM ideation_items WHERE project_slug = $1 AND status IN ('requested', 'drafting')
            ORDER BY status = 'drafting' DESC, updated_at`,
          [slug],
        )
      ).rows;
      for (const draft of drafts.filter((entry) => entry.status === 'drafting' && entry.agent)) {
        const agent = agents.find((entry) => entry.role === draft.agent && !entry.active);
        if (agent) Object.assign(agent, { active: true, orderTitle: `Neuer Auftrag: ${draft.title}` });
      }
      // Der Dashboard-Assistent ist kein Workflow-Agent, wird aber wie einer angezeigt (aktiv, solange er eine Chat-Anfrage bearbeitet).
      const chat = (
        await pool.query<{ content: string }>(
          `SELECT content FROM chat_messages
            WHERE project_slug = $1 AND role = 'user' AND status = 'processing' ORDER BY created_at LIMIT 1`,
          [slug],
        )
      ).rows[0];
      // Offene Rückfrage: letzte Assistenten-Nachricht ist eine Frage und noch nicht beantwortet.
      const question = chat
        ? undefined
        : (
            await pool.query<{ question: string }>(
              `SELECT question FROM chat_messages m
                WHERE m.project_slug = $1 AND m.role = 'assistant' AND m.question IS NOT NULL AND NOT ${ANSWERED}
                ORDER BY m.created_at DESC LIMIT 1`,
              [slug],
            )
          ).rows[0]?.question;
      agents.push({
        id: ASSISTANT_AGENT_ID,
        name: 'Dashboard-Assistent',
        phase: 'system',
        sprintName: null,
        orderTitle: chat
          ? `Chat: ${chat.content.replace(/\s+/g, ' ').slice(0, 60)}`
          : question
            ? `Rückfrage: ${question.slice(0, 80)}`
            : null,
        active: Boolean(chat),
        waiting: Boolean(question),
      });
      const visionary = (
        await pool.query<{ status: string; progress: string | null }>(
          `SELECT status, progress FROM visionary_runs
            WHERE project_slug = $1 AND status IN ('requested', 'running') ORDER BY requested_at DESC LIMIT 1`,
          [slug],
        )
      ).rows[0];
      agents.push({
        id: VISIONARY_AGENT_ID,
        name: 'Visionär',
        phase: 'system',
        sprintName: null,
        orderTitle: visionary
          ? visionary.status === 'running'
            ? `Ideen sammeln: ${visionary.progress ?? 'läuft …'}`.slice(0, 100)
            : 'Lauf angefragt – wartet auf den Worker'
          : null,
        active: Boolean(visionary),
      });
      const online = Boolean(beat) && beat.ageSeconds <= 60;
      response
        .set('Cache-Control', 'no-store')
        .json({ worker: beat && { ...beat, online }, online, running, agents, drafts });
    } catch (error) {
      next(error);
    }
  });
}
