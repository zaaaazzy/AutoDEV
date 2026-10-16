import { Pool } from 'pg';
import { ensureDefaultAgents } from '../api/agents.js';
import { SCHEMA } from './schema.js';

export interface DatabaseConfig {
  databaseUrl: string;
  adminDatabaseUrl: string;
}

export function readDatabaseConfig(environment: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const databaseUrl = environment.DEV_LOG_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DEV_LOG_DATABASE_URL must point to the dedicated dev_log database.');
  }
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
    const exists = await adminPool.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
      ['dev_log'],
    );
    if (!exists.rows[0]?.exists) {
      await adminPool.query('CREATE DATABASE dev_log');
      console.info('Created PostgreSQL database dev_log.');
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
    return pool;
  } catch (error) {
    await pool.end();
    throw error;
  }
}
