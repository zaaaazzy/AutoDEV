import { join } from 'node:path';
import pg from 'pg';
import { DEFAULT_DB_PASSWORD, warnDefaultDatabasePassword } from '../core/default-credentials.js';
import { runWatchdog } from './watchdog.js';

/** Einmaliger Wächter-Durchlauf; launchd startet ihn alle zwei Minuten (scripts/install-watchdog.sh). */
const root = join(import.meta.dirname, '..', '..');
const databaseUrl =
  process.env.DEV_LOG_DATABASE_URL ?? `postgresql://devlog:${DEFAULT_DB_PASSWORD}@localhost:5433/aideation`;
warnDefaultDatabasePassword(databaseUrl);
const pool = new pg.Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 5_000,
  max: 2,
});
pool.on('error', () => undefined);

runWatchdog({
  pool,
  localUrl: process.env.DEV_LOG_LOCAL_URL ?? 'http://127.0.0.1:3100',
  publicUrl: process.env.DEV_LOG_PUBLIC_URL?.trim() || null,
  backupDir: join(root, 'backups'),
  dataDir: root,
  installRoot: root,
})
  .catch((error: unknown) => {
    console.error('Wächter fehlgeschlagen:', error);
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
