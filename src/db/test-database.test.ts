import type { TestContext } from 'node:test';
import pg from 'pg';
import { runMigrations } from './migrations.js';

/**
 * Hilfen für Tests gegen eine echte PostgreSQL-Datenbank (lokal aus docker-compose oder
 * DEV_LOG_TEST_ADMIN_DATABASE_URL). Ohne Datenbank werden diese Tests übersprungen, ausser
 * DEV_LOG_TEST_REQUIRE_DATABASE ist gesetzt (CI): Dann schlagen sie fehl, statt still zu fehlen.
 */
export const ADMIN_URL =
  process.env.DEV_LOG_TEST_ADMIN_DATABASE_URL ??
  process.env.E2E_ADMIN_DATABASE_URL ??
  'postgresql://devlog:devlog_local_dev@localhost:5433/postgres';

/** Test überspringen, weil keine Datenbank erreichbar ist; mit DEV_LOG_TEST_REQUIRE_DATABASE ein Fehler. */
export function skipWithoutDatabase(t: TestContext): void {
  const message = `keine PostgreSQL-Datenbank unter ${new URL(ADMIN_URL).host}`;
  if (process.env.DEV_LOG_TEST_REQUIRE_DATABASE) throw new Error(`${message} (DEV_LOG_TEST_REQUIRE_DATABASE)`);
  t.skip(message);
}

/** Verbindung zur Verwaltungsdatenbank; undefined, wenn keine erreichbar ist (Test dann schon übersprungen). */
export async function adminPool(t: TestContext): Promise<pg.Pool | undefined> {
  const pool = new pg.Pool({ connectionString: ADMIN_URL, max: 1, connectionTimeoutMillis: 2000 });
  try {
    await pool.query('SELECT 1');
    return pool;
  } catch {
    await pool.end();
    skipWithoutDatabase(t);
    return undefined;
  }
}

export function databaseUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Frische, voll migrierte Wegwerf-Datenbank für einen Test; wird danach wieder gelöscht. */
export async function withMigratedDatabase(
  t: TestContext,
  prefix: string,
  run: (pool: pg.Pool) => Promise<void>,
): Promise<void> {
  const admin = await adminPool(t);
  if (!admin) return;
  const name = `${prefix}_${process.pid}`;
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ connectionString: databaseUrl(name), max: 2 });
  try {
    await runMigrations(pool);
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}
