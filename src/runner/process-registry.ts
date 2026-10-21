import type { Pool } from 'pg';
import { logged } from '../core/log.js';
import { killOrphan, type OrphanResult, type ProcessStore } from '../core/shutdown.js';

type Queryable = Pick<Pool, 'query'>;

/**
 * Prozessregister in der Datenbank. Schreibt in Startreihenfolge, damit ein schnelles Ende den Eintrag nicht vor
 * dem Anlegen löscht. Fehler werden gemeldet, halten den Befehl aber nicht auf.
 */
export function databaseProcessStore(pool: Queryable): ProcessStore & { flush(): Promise<void> } {
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (sql: string, params: unknown[]): void => {
    queue = queue.then(() => pool.query(sql, params)).then(() => undefined, logged('process-registry'));
  };
  return {
    add: (entry) =>
      enqueue('INSERT INTO agent_processes (pid, pid_started_at, command, cwd) VALUES ($1, $2, $3, $4)', [
        entry.pid,
        entry.startedAt,
        entry.command.slice(0, 200),
        entry.cwd.slice(0, 500),
      ]),
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
 * Beendet beim Start alle Prozesse des vorherigen Workers: aus dem Prozessregister (Chat, Autor, Visionär,
 * Testanforderungen …) und aus laufenden Agent-Schritten. Einträge, deren Prozess sicher beendet ist, werden
 * gelöscht; die anderen bleiben für den nächsten Versuch stehen.
 */
export async function killPreviousProcesses(
  pool: Queryable,
  kill: (pid: number, startedAt: Date) => OrphanResult = killOrphan,
): Promise<OrphanCleanup> {
  const { rows } = await pool.query<{ pid: number; startedAt: Date }>(
    `SELECT pid, pid_started_at AS "startedAt" FROM agent_processes
     UNION
     SELECT pid, pid_started_at FROM agent_run_steps
      WHERE status = 'running' AND pid IS NOT NULL AND pid_started_at IS NOT NULL`,
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
