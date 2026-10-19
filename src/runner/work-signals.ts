import type { Pool, PoolClient } from 'pg';
import { logged } from '../core/log.js';

/** Chat, ideas and analyses of a project (payload: project slug); see migration "work_notifications". */
export const WORK_CHANNEL = 'devlog_work';
/** An order became runnable; the work cycle should start now instead of after its interval. */
export const RUN_CHANNEL = 'devlog_run';

const RECONNECT_MS = 30_000;

/**
 * Keeps one connection on LISTEN for new work and reconnects after failures. While `listening` is false no signals
 * arrive, so callers must fall back to polling.
 */
export function listenForWork(
  pool: Pool,
  onSignal: (channel: string, project: string) => void,
): { readonly listening: boolean; stop: () => void } {
  let client: PoolClient | null = null;
  let stopped = false;
  let retry: NodeJS.Timeout | undefined;
  const schedule = (): void => {
    if (stopped || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      void connect();
    }, RECONNECT_MS);
  };
  const drop = (connection: PoolClient): void => {
    if (client === connection) client = null;
    connection.release(true);
    schedule();
  };
  const connect = async (): Promise<void> => {
    let connection: PoolClient | undefined;
    try {
      connection = await pool.connect();
      const current = connection;
      current.on('notification', (message) => onSignal(message.channel, message.payload ?? ''));
      current.on('error', logged('listen'));
      current.on('error', () => drop(current));
      await current.query(`LISTEN ${WORK_CHANNEL}`);
      await current.query(`LISTEN ${RUN_CHANNEL}`);
      if (stopped) return void current.release();
      client = current;
    } catch (error) {
      logged('listen')(error);
      if (connection) drop(connection);
      else schedule();
    }
  };
  void connect();
  return {
    get listening() {
      return client !== null;
    },
    stop: () => {
      stopped = true;
      clearTimeout(retry);
      client?.release();
      client = null;
    },
  };
}
