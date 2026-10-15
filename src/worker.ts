import type { Express } from 'express';
import type { Pool } from 'pg';
import { parseProjectSlug } from './validation.js';

export async function beatHeartbeat(
  pool: Pool, project: string, intervalSeconds: number, lastError: string | null = null, startup = false,
): Promise<void> {
  await pool.query(
    `INSERT INTO worker_heartbeats (project_slug, pid, interval_seconds, last_error)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_slug) DO UPDATE
       SET last_seen = NOW(), pid = $2, interval_seconds = $3, last_error = $4,
           started_at = CASE WHEN $5 THEN NOW() ELSE worker_heartbeats.started_at END`,
    [project, process.pid, intervalSeconds, lastError, startup],
  );
}

export function registerWorkerRoutes(app: Express, pool: Pool): void {
  app.get('/api/projects/:slug/worker', async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug);
      if (!slug) {
        response.status(400).json({ message: 'Ungültiges Projekt.' });
        return;
      }
      const beat = (await pool.query(
        `SELECT EXTRACT(EPOCH FROM (NOW() - last_seen))::int AS "ageSeconds", last_seen AS "lastSeen",
                started_at AS "startedAt", pid, interval_seconds AS "intervalSeconds", last_error AS "lastError"
           FROM worker_heartbeats WHERE project_slug = $1`, [slug],
      )).rows[0] ?? null;
      const running = (await pool.query(
        `SELECT d.id, d.title, r.started_at AS "startedAt"
           FROM agent_runs r JOIN development_items d ON d.id = r.development_id
          WHERE r.project_slug = $1 AND r.status = 'running' ORDER BY r.started_at`, [slug],
      )).rows;
      const online = Boolean(beat) && beat.ageSeconds <= 60;
      response.set('Cache-Control', 'no-store').json({ worker: beat && { ...beat, online }, online, running });
    } catch (error) {
      next(error);
    }
  });
}
