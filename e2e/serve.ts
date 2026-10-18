import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

/** Startet Dev Log für die Oberflächentests auf einer frisch angelegten Datenbank mit einem Beispielprojekt. */
const DATABASE = 'dev_log_e2e';
const adminUrl = process.env.E2E_ADMIN_DATABASE_URL!;
const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DATABASE}`);
await admin.end();

const url = new URL(adminUrl);
url.pathname = `/${DATABASE}`;
process.env.DEV_LOG_DATABASE_URL = url.toString();
delete process.env.DEV_LOG_ADMIN_DATABASE_URL;

const folder = join(tmpdir(), 'dev-log-e2e-project');
await mkdir(folder, { recursive: true });
process.env.E2E_PROJECT_FOLDER = folder;
process.env.DEV_LOG_PROJECT_ROOTS = tmpdir();

await import('../src/server.js');
