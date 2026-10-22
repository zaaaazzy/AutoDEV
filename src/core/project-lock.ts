import { existsSync, realpathSync } from 'node:fs';
import { Mutex } from './mutex.js';
import { isShuttingDown } from './shutdown.js';

const tails = new Map<string, Promise<unknown>>();

/** Gleicher Schlüssel für denselben Ordner, egal ob über Symlink, relativen oder echten Pfad angesprochen. */
function lockKey(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

/** Führt Befehle pro Projektordner nacheinander aus, damit z. B. git/npm/docker von Assistent, Agents und Git-Sync nicht gleichzeitig im selben Ordner arbeiten. */
export function withProjectLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const key = lockKey(path);
  const run = (tails.get(key) ?? Promise.resolve()).catch(() => undefined).then(task);
  const tail = run.catch(() => undefined);
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

const trees = new Map<string, { mutex: Mutex; holders: number }>();

/** Eine eigene Datenbankverbindung (pg PoolClient): Advisory-Locks gehören zur Sitzung, die sie genommen hat. */
export interface TreeLockClient {
  query(sql: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(error?: Error | boolean): void;
  on?(event: 'error', listener: (error: Error) => void): unknown;
  off?(event: 'error', listener: (error: Error) => void): unknown;
}

export interface TreeLockDatabase {
  connect(): Promise<TreeLockClient>;
}

let database: TreeLockDatabase | null = null;
const TREE_POLL_MS = 1_000;

/**
 * Ordner-Sperre prozessübergreifend machen: Jeder Worker (Host, Container, `runner-cli` ohne `--all`) nimmt zusätzlich
 * einen Postgres-Advisory-Lock auf denselben realpath-Schlüssel. Stirbt ein Worker, endet seine Verbindung und Postgres
 * gibt den Lock selbst frei – eine verwaiste Sperre kann es so nicht geben. Ohne Datenbank (Tests, CLI-Helfer) gilt
 * die Sperre nur in diesem Prozess.
 */
export function shareTreeLocks(next: TreeLockDatabase | null): void {
  database = next;
}

/** Schlüssel des Advisory-Locks: immer der realpath, nie das rohe cwd (sonst sperren Symlink und echter Pfad getrennt). */
export function treeLockName(path: string): string {
  return `aideation-tree:${lockKey(path)}`;
}

const TRY_LOCK = 'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked';
const UNLOCK = 'SELECT pg_advisory_unlock(hashtextextended($1, 0))';

/** Nimmt den Advisory-Lock auf einer eigenen Verbindung; `wait = false` versucht es genau einmal. */
async function lockDatabase(
  target: TreeLockDatabase,
  name: string,
  wait: boolean,
  onWait: () => void,
): Promise<(() => Promise<void>) | null> {
  const client = await target.connect();
  // Bricht die Verbindung ab, ist auch der Lock weg; das darf den Worker nicht beenden, nur gemeldet werden.
  const lost = (error: Error): void => console.error(`[Ordner-Sperre] Verbindung verloren (${name}): ${error.message}`);
  client.on?.('error', lost);
  const done = (error?: Error): void => {
    client.off?.('error', lost);
    client.release(error);
  };
  try {
    for (;;) {
      const { rows } = await client.query(TRY_LOCK, [name]);
      if (rows[0]?.locked === true) break;
      if (!wait) {
        done();
        return null;
      }
      onWait();
      if (isShuttingDown()) throw new Error('Worker wird beendet – Arbeitsordner nicht übernommen.');
      await new Promise((resolve) => setTimeout(resolve, TREE_POLL_MS));
    }
  } catch (error) {
    done(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
  return async () => {
    try {
      await client.query(UNLOCK, [name]);
      done();
    } catch (error) {
      // Verbindung verwerfen statt zurückgeben: Mit ihr endet auch ein noch gehaltener Lock.
      done(error instanceof Error ? error : new Error(String(error)));
    }
  };
}

/** Wartet ein Lauf auf den Ordner? Ein Hinweis je Wartezeit genügt (z. B. „wartet auf Arbeitsordner“). */
export type TreeWaitListener = () => void;

async function takeTree(path: string, wait: boolean, onWait?: TreeWaitListener): Promise<(() => void) | null> {
  const key = lockKey(path);
  const entry = trees.get(key) ?? { mutex: new Mutex(), holders: 0 };
  if (!wait && entry.holders > 0) return null;
  trees.set(key, entry);
  let notified = false;
  const waiting = (): void => {
    if (notified) return;
    notified = true;
    onWait?.();
  };
  if (entry.holders > 0) waiting();
  entry.holders += 1;
  // Reihenfolge überall gleich: erst die Sperre in diesem Prozess, dann die prozessübergreifende.
  const releaseLocal = await entry.mutex.acquire();
  const leave = (): void => {
    entry.holders -= 1;
    if (!entry.holders && trees.get(key) === entry) trees.delete(key);
    releaseLocal();
  };
  let releaseShared: (() => Promise<void>) | null = null;
  const target = database;
  if (target) {
    try {
      releaseShared = await lockDatabase(target, treeLockName(path), wait, waiting);
    } catch (error) {
      leave();
      throw error;
    }
    if (!releaseShared) {
      leave();
      return null;
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Erst den Lock in der Datenbank freigeben, dann den nächsten Wartenden in diesem Prozess weiterlassen.
    if (releaseShared) void releaseShared().finally(leave);
    else leave();
  };
}

/**
 * Exklusives Recht, im Arbeitsordner Dateien zu ändern und den Branch zu wechseln – für eine ganze Folge von Schritten
 * (ein Auftrag vom ersten ändernden Agent bis zum Merge, ein schreibender Chat-Lauf), nicht nur für einen Befehl.
 * So landen Änderungen des Assistenten nie im Commit eines Auftrags und kein Checkout wechselt einem Agent den Branch.
 * Gilt prozessübergreifend, sobald `shareTreeLocks` eine Datenbank gesetzt hat.
 */
export async function acquireTree(path: string, onWait?: TreeWaitListener): Promise<() => void> {
  return (await takeTree(path, true, onWait)) as () => void;
}

/**
 * Nimmt den Arbeitsordner nur, wenn er sofort frei ist (auch in keinem anderen Worker belegt), sonst `null`.
 * Prüfen und Nehmen sind ein Schritt: Zwischen „frei?“ und „nehmen“ kann sich kein anderer Lauf dazwischenschieben.
 */
export function tryAcquireTree(path: string): Promise<(() => void) | null> {
  return takeTree(path, false);
}

/** Hält gerade jemand den Arbeitsordner in diesem Prozess (oder wartet darauf)? Dann darf ein paralleler Lauf nur lesen. */
export function treeBusy(path: string): boolean {
  return (trees.get(lockKey(path))?.holders ?? 0) > 0;
}
