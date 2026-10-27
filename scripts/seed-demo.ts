import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localDatabaseUrl, readEnvValues } from '../src/core/local-database.js';
import { createDatabasePool } from '../src/db/database.js';
import { DEMO_SLUG, seedDemoProject } from '../e2e/demo/seed.js';

/**
 * Füllt eine Test- oder Entwicklungsdatenbank mit dem Beispielprojekt „Velowerk“ (25 Sprints Geschichte).
 * Aufruf: npm run seed:demo -- <datenbankname>   (Standard: dev_log_demo; nie die Live-Datenbank „aideation“).
 */
const name = process.argv[2] ?? 'dev_log_demo';
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name) || name === 'aideation') {
  console.error(`Ungültige oder gesperrte Datenbank: ${name}`);
  process.exit(1);
}
// Ohne vorgegebene Adresse der Zugang aus der .env; fehlt dort das Passwort, Abbruch statt Standardpasswort.
const admin = new URL(
  process.env.E2E_ADMIN_DATABASE_URL ??
    process.env.DEV_LOG_ADMIN_DATABASE_URL ??
    localDatabaseUrl(readEnvValues(join(import.meta.dirname, '..')), 'postgres', 'localhost'),
);
const database = new URL(admin);
database.pathname = `/${name}`;
const folder = join(tmpdir(), `${name.replaceAll('_', '-')}-velowerk`);
await mkdir(folder, { recursive: true });
const pool = await createDatabasePool({ databaseUrl: database.toString(), adminDatabaseUrl: admin.toString() });
try {
  const started = Date.now();
  await seedDemoProject(pool, folder);
  const counts = await pool.query(
    `SELECT (SELECT count(*) FROM sprints WHERE project_slug = $1) AS sprints,
            (SELECT count(*) FROM development_items WHERE project_slug = $1) AS orders,
            (SELECT count(*) FROM bugs WHERE project_slug = $1) AS bugs,
            (SELECT count(*) FROM agent_run_steps s JOIN agent_runs r ON r.id = s.run_id WHERE r.project_slug = $1) AS steps`,
    [DEMO_SLUG],
  );
  console.log(`Velowerk in ${name} (${Date.now() - started} ms):`, counts.rows[0]);
} finally {
  await pool.end();
}
