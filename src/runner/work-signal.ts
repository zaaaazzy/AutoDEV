import type { Pool, PoolClient } from 'pg';

/** Kanal, über den die Datenbank neue oder wieder eingeplante Arbeit meldet (Trigger in schema.ts). */
export const WORK_CHANNEL = 'devlog_work';

/**
 * Weckruf für die Auftragsschleife: Statt bis zu einem vollen Intervall zu schlafen, wacht der Worker auf, sobald
 * die Datenbank neue Arbeit meldet oder ein Lauf einen Platz frei macht. Das feste Intervall bleibt als Absicherung.
 */
export class WorkSignal {
  private pending = false;
  private resolveWait: (() => void) | null = null;

  wake(): void {
    this.pending = true;
    this.resolveWait?.();
  }

  /** Wartet höchstens `ms`, kehrt aber sofort zurück, wenn inzwischen geweckt wurde oder `stopped()` gilt. */
  async wait(ms: number, stopped: () => boolean, tickMs = 1000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!this.pending && !stopped() && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(tickMs, Math.max(0, deadline - Date.now())));
        this.resolveWait = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.resolveWait = null;
    }
    this.pending = false;
  }
}

/**
 * Hört dauerhaft auf {@link WORK_CHANNEL}. Bricht die Verbindung ab (z. B. Datenbank-Neustart), wird nach 15 s neu
 * verbunden; bis dahin arbeitet der Worker im normalen Intervall weiter. Liefert eine Funktion zum Beenden.
 */
export function listenForWork(pool: Pool, onWork: (project: string) => void, retryMs = 15_000): () => Promise<void> {
  let client: PoolClient | null = null;
  let stopped = false;
  let retry: NodeJS.Timeout | null = null;
  const connect = async (): Promise<void> => {
    if (stopped) return;
    try {
      const next = await pool.connect();
      next.on('notification', (message) => {
        if (message.channel === WORK_CHANNEL) onWork(message.payload ?? '');
      });
      next.on('error', () => {
        next.release(true);
        if (client === next) client = null;
        if (!stopped) retry = setTimeout(() => void connect(), retryMs);
      });
      await next.query(`LISTEN ${WORK_CHANNEL}`);
      client = next;
      // Was während der Unterbrechung eingeplant wurde, sofort abholen.
      onWork('');
    } catch {
      if (!stopped) retry = setTimeout(() => void connect(), retryMs);
    }
  };
  void connect();
  return async () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    const current = client;
    client = null;
    if (current) {
      await current.query(`UNLISTEN ${WORK_CHANNEL}`).catch(() => undefined);
      current.release();
    }
  };
}
