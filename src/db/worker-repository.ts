// Datenzugriff des Workers auf seine eigenen Tabellen: Lebenszeichen je Projekt und die Einstellung der Parallelität.
import { cpus, loadavg } from 'node:os';
import type { Pool } from 'pg';

/** Lebenszeichen je Projekt fürs Badge in der Oberfläche; `startup` setzt den Startzeitpunkt neu. */
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

/** Wie viele Projekte gleichzeitig Aufträge ausführen dürfen (app_settings.max_concurrent_agents, 1 bis 8). */
export async function readMaxAgents(pool: Pool): Promise<number> {
  const row = (
    await pool.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'max_concurrent_agents'`)
  ).rows[0];
  const value = Number(row?.value);
  return Number.isInteger(value) && value >= 1 && value <= MAX_AGENTS_LIMIT ? value : DEFAULT_MAX_AGENTS;
}
