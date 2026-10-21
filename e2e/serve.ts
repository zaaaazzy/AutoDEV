import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

/** Startet AIdeation für die Oberflächentests auf einer frisch angelegten Datenbank mit einem Beispielprojekt. */
const DATABASE = process.env.E2E_DATABASE ?? 'dev_log_e2e';
const adminUrl = process.env.E2E_ADMIN_DATABASE_URL!;
const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DATABASE}`);
await admin.end();

const url = new URL(adminUrl);
url.pathname = `/${DATABASE}`;
process.env.DEV_LOG_DATABASE_URL = url.toString();
delete process.env.DEV_LOG_ADMIN_DATABASE_URL;

const folder = join(tmpdir(), `${DATABASE.replaceAll('_', '-')}-project`);
await mkdir(folder, { recursive: true });
process.env.E2E_PROJECT_FOLDER = folder;
process.env.DEV_LOG_PROJECT_ROOTS = tmpdir();

// Beispielprojekt „Velowerk“ (25 Sprints Geschichte), damit die Testinstanz wie eine echte aussieht.
// Abschalten mit E2E_DEMO_DATA=0.
if (process.env.E2E_DEMO_DATA !== '0') {
  const { createDatabasePool } = await import('../src/db/database.js');
  const { seedDemoProject } = await import('./demo/seed.js');
  const demoFolder = join(tmpdir(), `${DATABASE.replaceAll('_', '-')}-velowerk`);
  await mkdir(demoFolder, { recursive: true });
  const pool = await createDatabasePool({ databaseUrl: url.toString(), adminDatabaseUrl: adminUrl });
  try {
    await seedDemoProject(pool, demoFolder);
  } finally {
    await pool.end();
  }
}

await import('../src/server.js');
