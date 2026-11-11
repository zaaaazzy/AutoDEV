import { join } from 'node:path';
import pg from 'pg';
import { warnDefaultDatabasePassword } from '../core/default-credentials.js';
import { loadInstallEnv, requireDatabaseUrl } from '../core/local-database.js';
import { runWatchdog } from './watchdog.js';

/**
 * Einmaliger Wächter-Durchlauf alle zwei Minuten: per launchd (scripts/install-watchdog.sh) oder im Compose-Dienst
 * watchdog (deploy/worker/entrypoint.sh).
 */
const root = join(import.meta.dirname, '..', '..');
// Env-Datei des Dienstes (--env-file) vor der .env der Installation; ohne Datenbank-URL kein Standardpasswort.
loadInstallEnv(root);
let databaseUrl: string;
try {
  databaseUrl = requireDatabaseUrl();
} catch (error) {
  console.error(`Wächter: ${(error as Error).message}`);
  process.exit(1);
}
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
