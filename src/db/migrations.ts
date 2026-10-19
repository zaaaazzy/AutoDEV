import type { PoolClient } from 'pg';

/**
 * Schema changes after the base schema, applied once each and in order. Never edit or reorder an entry that has
 * shipped; append a new one instead. The base schema (schema.ts) only creates missing tables, so new columns on
 * existing tables must come through here.
 */
export const MIGRATIONS: readonly { name: string; sql: string }[] = [
  {
    // Moves the loose "model:<role>", "command:<role>" and "allow_tools:<role>" keys out of app_settings.
    name: 'system_agent_settings',
    sql: `
      CREATE TABLE system_agent_settings (
        role TEXT PRIMARY KEY,
        model TEXT,
        command JSONB CHECK (command IS NULL OR jsonb_typeof(command) = 'array'),
        allow_tools BOOLEAN NOT NULL DEFAULT FALSE
      );
      INSERT INTO system_agent_settings (role, model, command, allow_tools)
      SELECT r.role,
             (SELECT NULLIF(btrim(value), '') FROM app_settings WHERE key = 'model:' || r.role),
             (SELECT CASE WHEN pg_input_is_valid(value, 'jsonb') THEN
                       CASE WHEN jsonb_typeof(value::jsonb) = 'array' THEN value::jsonb END END
                FROM app_settings WHERE key = 'command:' || r.role),
             COALESCE((SELECT value = 'true' FROM app_settings WHERE key = 'allow_tools:' || r.role), FALSE)
        FROM (SELECT DISTINCT split_part(key, ':', 2) AS role FROM app_settings
               WHERE key ~ '^(model|command|allow_tools):') r;
      DELETE FROM app_settings WHERE key ~ '^(model|command|allow_tools):';
    `,
  },
  {
    // Orders of such projects run in their own Git worktree and branch instead of the project folder.
    name: 'projects_isolated_runs',
    sql: `ALTER TABLE projects ADD COLUMN IF NOT EXISTS isolated_runs BOOLEAN NOT NULL DEFAULT FALSE;`,
  },
  {
    // Lets the worker react to new work at once instead of polling (src/runner/work-signals.ts).
    name: 'work_notifications',
    sql: `
      CREATE OR REPLACE FUNCTION devlog_notify() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_notify(TG_ARGV[0], NEW.project_slug);
        RETURN NULL;
      END $$;
      CREATE TRIGGER chat_messages_work AFTER INSERT OR UPDATE OF status ON chat_messages
        FOR EACH ROW WHEN (NEW.status = 'pending') EXECUTE FUNCTION devlog_notify('devlog_work');
      CREATE TRIGGER ideation_items_work AFTER INSERT OR UPDATE OF status ON ideation_items
        FOR EACH ROW WHEN (NEW.status IN ('idea', 'considering', 'requested')) EXECUTE FUNCTION devlog_notify('devlog_work');
      CREATE TRIGGER development_items_analysis AFTER INSERT OR UPDATE OF analysis_status ON development_items
        FOR EACH ROW WHEN (NEW.analysis_status = 'requested') EXECUTE FUNCTION devlog_notify('devlog_work');
      CREATE TRIGGER development_items_run AFTER INSERT OR UPDATE OF status ON development_items
        FOR EACH ROW WHEN (NEW.status = 'planned') EXECUTE FUNCTION devlog_notify('devlog_run');
      CREATE TRIGGER sprints_run AFTER INSERT OR UPDATE OF status ON sprints
        FOR EACH ROW WHEN (NEW.status = 'active') EXECUTE FUNCTION devlog_notify('devlog_run');
    `,
  },
];

/** Applies pending migrations, each in its own transaction. The caller holds the schema advisory lock. */
export async function applyMigrations(
  client: Pick<PoolClient, 'query'>,
  migrations: readonly { name: string; sql: string }[] = MIGRATIONS,
): Promise<string[]> {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const applied = new Set(
    (await client.query<{ version: number }>('SELECT version FROM schema_migrations')).rows.map((row) => row.version),
  );
  const done: string[] = [];
  for (const [index, migration] of migrations.entries()) {
    const version = index + 1;
    if (applied.has(version)) continue;
    await client.query('BEGIN');
    try {
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [version, migration.name]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${version} (${migration.name}) fehlgeschlagen: ${String(error)}`, { cause: error });
    }
    done.push(migration.name);
  }
  return done;
}
