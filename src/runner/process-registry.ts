import type { Pool } from 'pg';
import { logged } from '../core/log.js';
import { killOrphan, type OrphanResult, type ProcessStore } from '../core/shutdown.js';
import { currentWorkerId, liveWorkerSql, WORKER_STALE_SECONDS } from './worker-identity.js';
import { AGENT_STEP_STATUS } from '../core/status.js';

type Queryable = Pick<Pool, 'query'>;

/**
 * Prozessregister in der Datenbank. Schreibt in Startreihenfolge, damit ein schnelles Ende den Eintrag nicht vor
 * dem Anlegen löscht. Fehler werden gemeldet, halten den Befehl aber nicht auf.
 */
export function databaseProcessStore(
  pool: Queryable,
  workerId: string | null = currentWorkerId(),
): ProcessStore & { flush(): Promise<void> } {
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (sql: string, params: unknown[]): void => {
    queue = queue.then(() => pool.query(sql, params)).then(() => undefined, logged('process-registry'));
  };
  return {
    add: (entry) =>
      enqueue(
        'INSERT INTO agent_processes (pid, pid_started_at, command, cwd, worker_id) VALUES ($1, $2, $3, $4, $5)',
        [entry.pid, entry.startedAt, entry.command.slice(0, 200), entry.cwd.slice(0, 500), workerId],
      ),
    remove: (entry) =>
      enqueue('DELETE FROM agent_processes WHERE pid = $1 AND pid_started_at = $2', [entry.pid, entry.startedAt]),
    flush: () => queue,
  };
}

export interface OrphanCleanup {
  killed: number;
  /** Altprozesse, die womöglich noch laufen. Solange es welche gibt, darf nichts erneut eingeplant werden. */
  failed: number;
}

/**
 * Läufe „läuft“, die dieser Worker beim Start aufräumen darf: eigene (gleiche Worker-ID, also vom Vorgänger) und
 * solche, deren Worker kein frisches Lebenszeichen mehr hat. Altläufe ohne Worker-ID gelten als verwaist, wenn das
 * Lebenszeichen ihres Projekts alt ist. Platzhalter: $1 = eigene Worker-ID, $2 = WORKER_STALE_SECONDS.
 */
export const RECLAIMABLE_RUN_SQL = `(r.worker_id = $1
   OR (r.worker_id IS NOT NULL AND NOT ${liveWorkerSql('r.worker_id', '$2')})
   OR (r.worker_id IS NULL AND NOT EXISTS (
         SELECT 1 FROM worker_heartbeats h
          WHERE h.project_slug = r.project_slug AND h.last_seen > NOW() - $2::int * INTERVAL '1 second')))`;

/**
 * Beendet beim Start die Prozesse des vorherigen bzw. eines beendeten Workers: aus dem Prozessregister (Chat, Autor,
 * Visionär, Testanforderungen …) und aus laufenden Agent-Schritten. Prozesse eines anderen, lebenden Workers bleiben
 * unberührt (Registereinträge ohne Worker-ID stammen aus älteren Ständen und gelten als verwaist). Einträge, deren
 * Prozess sicher beendet ist, werden gelöscht; die anderen bleiben für den nächsten Versuch stehen.
 */
export async function killPreviousProcesses(
  pool: Queryable,
  kill: (pid: number, startedAt: Date) => OrphanResult = killOrphan,
  workerId: string | null = currentWorkerId(),
): Promise<OrphanCleanup> {
  const { rows } = await pool.query<{ pid: number; startedAt: Date }>(
    `SELECT pid, pid_started_at AS "startedAt" FROM agent_processes p
      WHERE p.worker_id IS NULL OR p.worker_id = $1 OR NOT ${liveWorkerSql('p.worker_id', '$2')}
     UNION
     SELECT s.pid, s.pid_started_at FROM agent_run_steps s JOIN agent_runs r ON r.id = s.run_id
      WHERE s.status = '${AGENT_STEP_STATUS.running}' AND s.pid IS NOT NULL AND s.pid_started_at IS NOT NULL
        AND ${RECLAIMABLE_RUN_SQL}`,
    [workerId, WORKER_STALE_SECONDS],
  );
  const result: OrphanCleanup = { killed: 0, failed: 0 };
  for (const row of rows) {
    const outcome = kill(row.pid, new Date(row.startedAt));
    if (outcome === 'failed') {
      result.failed += 1;
      console.warn(
        `Verwaister Prozess ${row.pid} läuft womöglich noch; zugehörige Anfragen werden nicht neu gestartet.`,
      );
      continue;
    }
    if (outcome === 'killed') {
      result.killed += 1;
      console.info(`Verwaisten Agent-Prozess ${row.pid} beendet.`);
    }
    await pool.query('DELETE FROM agent_processes WHERE pid = $1 AND pid_started_at = $2', [row.pid, row.startedAt]);
  }
  return result;
}
