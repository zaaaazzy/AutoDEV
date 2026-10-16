const tails = new Map<string, Promise<unknown>>();

/** Führt Befehle pro Projektordner nacheinander aus, damit z. B. git/npm/docker von Assistent, Agents und Git-Sync nicht gleichzeitig im selben Ordner arbeiten. */
export function withProjectLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (tails.get(key) ?? Promise.resolve()).catch(() => undefined).then(task);
  const tail = run.catch(() => undefined);
  tails.set(key, tail);
  void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return run;
}
