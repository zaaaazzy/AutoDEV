import { warnDefaultDatabasePassword } from '../core/default-credentials.js';
import { logged } from '../core/log.js';
import { Pool } from 'pg';
import { ensureDefaultAgents, ensureReviewer } from '../api/agents.js';
import { SCHEMA } from './schema.js';
import { seedDefaultActions, seedRoutineTemplates } from '../api/agent-tasks.js';
import { materializeAgentCommands } from '../agent/tool-permissions.js';

export interface DatabaseConfig {
  databaseUrl: string;
  adminDatabaseUrl: string;
}

export function readDatabaseConfig(environment: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const databaseUrl = environment.DEV_LOG_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DEV_LOG_DATABASE_URL must point to the dedicated AIdeation database.');
  }
  warnDefaultDatabasePassword(databaseUrl);
  const adminDatabaseUrl = environment.DEV_LOG_ADMIN_DATABASE_URL?.trim();
  if (adminDatabaseUrl) {
    return { databaseUrl, adminDatabaseUrl };
  }
  const admin = new URL(databaseUrl);
  admin.pathname = '/postgres';
  return { databaseUrl, adminDatabaseUrl: admin.toString() };
}

export async function ensureDatabase(config: DatabaseConfig): Promise<void> {
  const adminPool = new Pool({ connectionString: config.adminDatabaseUrl, max: 1 });
  try {
    // Name aus der Adresse (z. B. aideation); nur einfache Namen, damit er sicher in CREATE DATABASE steht.
    const name = decodeURIComponent(new URL(config.databaseUrl).pathname.replace(/^\//, '')) || 'aideation';
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`Ungültiger Datenbankname: ${name}`);
    const exists = await adminPool.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
      [name],
    );
    if (!exists.rows[0]?.exists) {
      await adminPool.query(`CREATE DATABASE ${name}`);
      console.info(`Created PostgreSQL database ${name}.`);
    }
  } finally {
    await adminPool.end();
  }
}

export async function createDatabasePool(config: DatabaseConfig): Promise<Pool> {
  await ensureDatabase(config);
  const pool = new Pool({ connectionString: config.databaseUrl });
  // Idle connection failures, such as a PostgreSQL restart, must not terminate the process.
  pool.on('error', (error) => console.error('Datenbankverbindung getrennt:', error.message));
  try {
    // Serialises schema changes when the server and the runner start at the same time.
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(727401)');
      await client.query(SCHEMA);
    } finally {
      await client.query('SELECT pg_advisory_unlock(727401)').catch(() => undefined);
      client.release();
    }
    const projects = await pool.query<{ slug: string }>('SELECT slug FROM projects WHERE NOT agents_seeded');
    for (const project of projects.rows) {
      await ensureDefaultAgents(pool, project.slug);
    }
    // Standard-Aktionen (Quick Actions) einmalig je Projekt anlegen und dem Tester zuweisen.
    for (const project of (await pool.query<{ slug: string }>('SELECT slug FROM projects')).rows) {
      await seedDefaultActions(pool, project.slug).catch(logged('database'));
      // Routine-Vorlagen (deaktiviert) einmalig je Projekt.
      await seedRoutineTemplates(pool, project.slug).catch(logged('database'));
      await materializeAgentCommands(pool, project.slug).catch(logged('database'));
    }
    const withoutReviewer = await pool.query<{ slug: string }>('SELECT slug FROM projects WHERE NOT reviewer_seeded');
    for (const project of withoutReviewer.rows) {
      await ensureReviewer(pool, project.slug);
    }
    return pool;
  } catch (error) {
    await pool.end();
    throw error;
  }
}
