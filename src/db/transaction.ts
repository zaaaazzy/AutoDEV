import type { Pool, PoolClient } from 'pg';

/** Abfragen über den Pool oder eine feste Verbindung (z. B. innerhalb von withTransaction). */
export type Queryable = Pick<Pool, 'query'>;

/**
 * Führt mehrstufige Änderungen in einer Transaktion auf einer festen Verbindung aus: alle Abfragen in `work` über
 * `client`, nicht über den Pool. Wirft `work` (oder COMMIT), wird zurückgerollt und der Fehler weitergereicht.
 * Scheitert auch das ROLLBACK, ist der Zustand der Verbindung unklar: Sie wird dann verworfen statt zurückgegeben.
 */
export async function withTransaction<T>(
  pool: Pick<Pool, 'connect'>,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError: unknown) => {
      broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    });
    throw error;
  } finally {
    client.release(broken);
  }
}

/** Verletzung eines Unique-Index (PostgreSQL 23505), z. B. ein zweiter Auftrag zur selben Idee. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}
