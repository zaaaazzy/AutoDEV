import { existsSync, realpathSync } from 'node:fs';
import { Mutex } from './mutex.js';

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

/**
 * Exklusives Recht, im Arbeitsordner Dateien zu ändern und den Branch zu wechseln – für eine ganze Folge von Schritten
 * (ein Auftrag vom ersten ändernden Agent bis zum Merge, ein schreibender Chat-Lauf), nicht nur für einen Befehl.
 * So landen Änderungen des Assistenten nie im Commit eines Auftrags und kein Checkout wechselt einem Agent den Branch.
 */
export async function acquireTree(path: string): Promise<() => void> {
  const key = lockKey(path);
  const entry = trees.get(key) ?? { mutex: new Mutex(), holders: 0 };
  trees.set(key, entry);
  entry.holders += 1;
  const release = await entry.mutex.acquire();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.holders -= 1;
    if (!entry.holders && trees.get(key) === entry) trees.delete(key);
    release();
  };
}

/** Hält gerade jemand den Arbeitsordner (oder wartet darauf)? Dann darf ein paralleler Lauf nur lesen. */
export function treeBusy(path: string): boolean {
  return (trees.get(lockKey(path))?.holders ?? 0) > 0;
}
