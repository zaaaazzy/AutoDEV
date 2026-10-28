// Worker-ID und Lebenszeichen: Wer einen Lauf oder Prozess angelegt hat, und lebt dieser Worker noch?
// Beim Start räumt ein Worker nur eigene Läufe auf (gleiche ID, also der eigene Vorgänger) und solche, deren Worker
// kein frisches Lebenszeichen mehr hat. Die Läufe eines zweiten, lebenden Workers bleiben unberührt.
import { hostname } from 'node:os';
import type { Pool } from 'pg';

type Queryable = Pick<Pool, 'query'>;

/** So oft schreibt ein Worker sein Lebenszeichen. */
export const WORKER_BEAT_MS = 20_000;
/** Ohne Lebenszeichen seit dieser Zeit gilt ein Worker als beendet; seine Läufe und Prozesse sind verwaist. */
export const WORKER_STALE_SECONDS = 90;

/**
 * Feste ID je Installation und Bereich: Ein Neustart desselben Workers bekommt dieselbe ID und räumt die Reste seines
 * Vorgängers auf; eine zweite Installation (z. B. die Kopie „AIdeation/agent“) oder ein anderes Projekt hat eine eigene.
 * DEV_LOG_WORKER_ID setzt sie von Hand (z. B. im Container, dessen Hostname wechselt).
 */
export function workerIdFor(env: NodeJS.ProcessEnv, installRoot: string, scope: string, host = hostname()): string {
  return env.DEV_LOG_WORKER_ID?.trim() || `${host}:${installRoot}:${scope}`;
}

let current: string | null = null;

/** ID dieses Workers; null, solange keine gesetzt ist (Tests, Werkzeuge ohne Worker). */
export function currentWorkerId(): string | null {
  return current;
}

export function setWorkerId(id: string | null): void {
  current = id;
}

/** Lebenszeichen schreiben (Zeit der Datenbank, damit abweichende Uhren von Host und Container nicht stören). */
export async function beatWorker(pool: Queryable, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO runner_workers (id, pid, host) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET last_seen = NOW(), pid = $2, host = $3`,
    [id, process.pid, hostname()],
  );
}

/**
 * SQL-Bedingung „der Worker in dieser Spalte lebt“ (frisches Lebenszeichen). staleParam ist der Platzhalter für
 * WORKER_STALE_SECONDS, z. B. '$2'.
 */
export function liveWorkerSql(column: string, staleParam: string): string {
  return `EXISTS (SELECT 1 FROM runner_workers w
                   WHERE w.id = ${column} AND w.last_seen > NOW() - ${staleParam}::int * INTERVAL '1 second')`;
}
