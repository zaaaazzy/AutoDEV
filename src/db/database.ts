import { refuseDefaultDatabasePassword } from '../core/default-credentials.js';
import { logged } from '../core/log.js';
import { Pool } from 'pg';
import { ensureDefaultAgents, ensureReviewer } from '../api/agents.js';
import { runMigrations } from './migrations.js';
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
  refuseDefaultDatabasePassword(databaseUrl, environment);
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

/**
 * Verbindung zu einer bestehenden AIdeation-Datenbank ohne Migrationen und Startdaten. Für Werkzeuge, die mit dem Code
 * eines noch nicht freigegebenen Stands laufen (Test-Gate eines Sprints): Sie dürfen nur hineinschreiben, nie das Schema
 * der laufenden Installation auf ihren Stand heben.
 */
export function connectExistingDatabase(config: DatabaseConfig): Pool {
  const pool = new Pool({ connectionString: config.databaseUrl });
  pool.on('error', (error) => console.error('Datenbankverbindung getrennt:', error.message));
  return pool;
}

export async function createDatabasePool(config: DatabaseConfig): Promise<Pool> {
  await ensureDatabase(config);
  const pool = new Pool({ connectionString: config.databaseUrl });
  // Idle connection failures, such as a PostgreSQL restart, must not terminate the process.
  pool.on('error', (error) => console.error('Datenbankverbindung getrennt:', error.message));
  try {
    // Nur ausstehende Migrationen; Sperre und Transaktionen brauchen dieselbe Verbindung.
    const client = await pool.connect();
    try {
      await runMigrations(client);
    } finally {
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
