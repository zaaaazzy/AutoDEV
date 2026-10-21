import type { Pool } from 'pg';
import { SCHEMA } from './schema.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Sperre, die API, Runner und Watchdog beim gleichzeitigen Start hintereinander migrieren lässt. */
export const MIGRATION_LOCK = 727401;

// Daten-Korrekturen, die früher bei jedem Start mitliefen. Sie laufen jetzt genau einmal, nach dem Basisschritt.
const LEGACY_DATA = `
  -- Angenommene Ideen, deren Auftrag gelöscht wurde, sind wieder offen.
  UPDATE ideation_items i SET status = 'idea', updated_at = NOW()
   WHERE i.status = 'accepted' AND NOT EXISTS (SELECT 1 FROM development_items d WHERE d.ideation_id = i.id);
  -- Erledigte oder abgelehnte Aufträge brauchen keine Aktion mehr (Altfälle; neue löscht der Trigger).
  UPDATE development_items SET action_todo = NULL
   WHERE status IN ('done', 'rejected') AND action_todo IS NOT NULL;
  -- Ältere Geräte ohne Besitzer stammen aus der Zeit vor Benutzerkonten: dem Systemadministrator zuordnen.
  UPDATE push_subscriptions SET system_admin = TRUE WHERE user_id IS NULL AND NOT system_admin;
  -- Einführung der Mandantentrennung: bestehende Benutzer behalten Zugriff auf die bestehenden Projekte.
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'tenancy_migrated') THEN
      INSERT INTO project_members (user_id, project_slug)
        SELECT u.id, p.slug FROM users u CROSS JOIN projects p ON CONFLICT DO NOTHING;
      INSERT INTO app_settings (key, value) VALUES ('tenancy_migrated', 'true');
    END IF;
  END $$;
  -- Dateirechte getrennt: „files“ wird zu „Dateien anlegen“ und „Dateien ändern“.
  UPDATE agents SET allowed_commands = ARRAY(
      SELECT DISTINCT unnest(array_remove(allowed_commands, 'files') || ARRAY['files:create', 'files:edit']))
    WHERE 'files' = ANY(allowed_commands);
  UPDATE project_permission_groups SET rules = ARRAY(
      SELECT DISTINCT unnest(array_remove(rules, 'files') || ARRAY['files:create', 'files:edit']))
    WHERE 'files' = ANY(rules);
  -- launchctl-Freigabe ohne feste Benutzer-ID (der Container hat eine andere als der Worker).
  UPDATE agents SET allowed_commands = ARRAY(SELECT DISTINCT CASE
      WHEN rule ~ '^Bash\\(launchctl kickstart -k gui/[0-9]+/ch\\.\\*\\)$' THEN 'services' ELSE rule END
      FROM unnest(allowed_commands) rule)
    WHERE EXISTS (SELECT 1 FROM unnest(allowed_commands) rule WHERE rule LIKE 'Bash(launchctl kickstart -k gui/%');
  -- Systemagents: alte app_settings-Schlüssel (model:, command:, allow_tools:) wandern nach system_agent_settings.
  INSERT INTO system_agent_settings (role, model, command, allow_tools)
  SELECT r.role,
         (SELECT NULLIF(btrim(value), '') FROM app_settings WHERE key = 'model:' || r.role),
         (SELECT CASE WHEN pg_input_is_valid(value, 'jsonb') THEN
                   CASE WHEN jsonb_typeof(value::jsonb) = 'array' THEN value::jsonb END END
            FROM app_settings WHERE key = 'command:' || r.role),
         COALESCE((SELECT value = 'true' FROM app_settings WHERE key = 'allow_tools:' || r.role), FALSE)
    FROM (SELECT DISTINCT split_part(key, ':', 2) AS role FROM app_settings
           WHERE key ~ '^(model|command|allow_tools):') r
  ON CONFLICT (role) DO NOTHING;
  DELETE FROM app_settings WHERE key ~ '^(model|command|allow_tools):';
  -- Die bisherige Kostenbremse je Auftrag (Spalten an projects) wandert in budgets.
  INSERT INTO budgets (project_slug, period, max_tokens, max_cost_usd)
  SELECT slug, 'order', order_token_limit, order_cost_limit FROM projects
   WHERE order_token_limit IS NOT NULL OR order_cost_limit IS NOT NULL
  ON CONFLICT (project_slug, period) DO NOTHING;
  UPDATE projects SET order_token_limit = NULL, order_cost_limit = NULL
   WHERE order_token_limit IS NOT NULL OR order_cost_limit IS NOT NULL;
`;

/**
 * Nummerierte Schritte, jeder läuft genau einmal (vermerkt in schema_migrations). Bestehende Schritte nie ändern
 * oder umnummerieren, Neues hinten anhängen.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'basis', sql: SCHEMA },
  { version: 2, name: 'daten-altbestand', sql: LEGACY_DATA },
  // Schritte je Agent (Kosten, Löschen eines Agents mit ON DELETE SET NULL) ohne Tabellen-Scan.
  {
    version: 3,
    name: 'agent-run-steps-agent-index',
    sql: 'CREATE INDEX IF NOT EXISTS agent_run_steps_agent_idx ON agent_run_steps (agent_id);',
  },
];

type Queryable = Pick<Pool, 'query'>;

/**
 * Führt die ausstehenden Migrationen aus, jede in eigener Transaktion, alle unter einer Advisory-Sperre.
 * Braucht eine feste Verbindung (PoolClient), weil Sperre und Transaktion an der Sitzung hängen.
 * Ist die Datenbank auf dem Stand, läuft nur die Abfrage der Versionen. Gibt die neu angewandten Versionen zurück.
 */
export async function runMigrations(
  client: Queryable,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<number[]> {
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const done = new Set(
      (await client.query<{ version: number }>('SELECT version FROM schema_migrations')).rows.map((row) => row.version),
    );
    const known = new Set(migrations.map((migration) => migration.version));
    const unknown = [...done].filter((version) => !known.has(version));
    if (unknown.length > 0) {
      console.warn(`Datenbank kennt neuere Migrationen (${unknown.join(', ')}) als dieser Stand des Codes.`);
    }
    const applied: number[] = [];
    for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
      if (done.has(migration.version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
          migration.version,
          migration.name,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration ${migration.version} (${migration.name}) fehlgeschlagen: ${message}`, {
          cause: error,
        });
      }
      console.info(`Migration ${migration.version} (${migration.name}) angewandt.`);
      applied.push(migration.version);
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined);
  }
}
