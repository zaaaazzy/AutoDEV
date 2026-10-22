import { join } from 'node:path';
import type { TestContext } from 'node:test';
import pg from 'pg';
import { runMigrations } from './migrations.js';
import { localDatabaseUrl, readEnvValues } from '../core/local-database.js';

/**
 * Hilfen für Tests gegen eine echte PostgreSQL-Datenbank: DEV_LOG_TEST_ADMIN_DATABASE_URL, sonst die lokale aus
 * docker-compose mit dem Zugang aus der .env (wie e2e/playwright.config.ts). Ohne Datenbank werden diese Tests übersprungen, ausser
 * DEV_LOG_TEST_REQUIRE_DATABASE ist gesetzt (CI): Dann schlagen sie fehl, statt still zu fehlen.
 */
export const ADMIN_URL =
  process.env.DEV_LOG_TEST_ADMIN_DATABASE_URL ??
  process.env.E2E_ADMIN_DATABASE_URL ??
  localDatabaseUrl(readEnvValues(join(import.meta.dirname, '..', '..')), 'postgres', 'localhost');

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

/**
 * Löscht eine Test-Datenbank. pool.end() meldet sich fertig, bevor die Verbindungen wirklich zu sind; ein sofortiges
 * DROP … WITH (FORCE) bricht sie dann hart ab, und der Client wirft 57P01 als uncaughtException. Darum erst warten,
 * bis keine Verbindung mehr auf die Datenbank zeigt (FORCE nur noch für Hängengebliebenes).
 */
export async function dropDatabase(admin: pg.Pool, name: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const open = await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [
      name,
    ]);
    if (!open.rowCount) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
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
  await dropDatabase(admin, name);
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ connectionString: databaseUrl(name), max: 2 });
  try {
    await runMigrations(pool);
    await run(pool);
  } finally {
    await pool.end();
    await dropDatabase(admin, name);
    await admin.end();
  }
}
