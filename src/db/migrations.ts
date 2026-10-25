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
  }, // Stand von main, der parallel zu Sprint 9 entstand (Sprint abbrechen, Autopilot live, Testfortschritt,
  // Nutzungslimit, Git-Zustand und Git-Lösungen). Alles idempotent: läuft auch dort, wo es schon angelegt ist.
  {
    version: 4,
    name: 'main-parallel-zu-sprint-9',
    sql: `
      -- Sprint abgebrochen: laufende Agents werden beendet, offene Aufträge gehen zurück ins Backlog; kein Git-Sync.
      ALTER TABLE sprints DROP CONSTRAINT IF EXISTS sprints_status_check;
      ALTER TABLE sprints ADD CONSTRAINT sprints_status_check
        CHECK (status IN ('planned', 'active', 'review', 'completed', 'cancelled'));
      -- Autopilot schaltet einen fertigen Sprint selbst live (Test-Gate, Merge nach main, Push), statt auf das Go zu warten.
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS autopilot_auto_live BOOLEAN NOT NULL DEFAULT FALSE;
      -- Live-Fortschritt eines laufenden Testschritts („13 von 28 Tests · 12 ✓ · 1 ✗“) und Start für die Laufzeit.
      ALTER TABLE test_run_steps ADD COLUMN IF NOT EXISTS progress TEXT;
      ALTER TABLE test_run_steps ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ DEFAULT NOW();
      -- Nutzungslimit des Agent-Kontos erreicht: der Auftrag bleibt geplant und startet erst ab dieser Zeit wieder.
      ALTER TABLE development_items ADD COLUMN IF NOT EXISTS retry_after TIMESTAMPTZ;
      -- Git-Zustand der Projektordner (Branch, offene Änderungen, Abstand zu GitHub), vom Worker jede Minute erfasst;
      -- riskante Aktionen (Live schalten, Freigeben, Sprint starten) prüfen ihn vorher.
      ALTER TABLE project_git_graphs ADD COLUMN IF NOT EXISTS state JSONB;
      ALTER TABLE project_git_graphs ADD COLUMN IF NOT EXISTS state_at TIMESTAMPTZ;
      ALTER TABLE project_git_graphs ALTER COLUMN graph DROP NOT NULL;
      -- Lösungen auf Knopfdruck (Zwischenstand sichern, zurück auf main, main mit GitHub abgleichen), vom Worker ausgeführt.
      CREATE TABLE IF NOT EXISTS git_fix_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE ON UPDATE CASCADE,
        fix TEXT NOT NULL CHECK (fix IN ('save_wip', 'checkout_main', 'sync_main')),
        role TEXT NOT NULL DEFAULT 'live' CHECK (role IN ('live', 'agents')),
        status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'running', 'done', 'failed')),
        message TEXT,
        requested_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ
      );
      CREATE UNIQUE INDEX IF NOT EXISTS git_fix_requests_open_idx ON git_fix_requests (project_slug)
        WHERE status IN ('requested', 'running');
      CREATE INDEX IF NOT EXISTS git_fix_requests_project_idx ON git_fix_requests (project_slug, created_at DESC);
    `,
  },
  // Rollback-Vorschlag nach kritischem Betriebsfehler: Sprint-Tag je Deploy, laufender Deploy, Rollback-Protokoll.
  {
    version: 5,
    name: 'production-rollback',
    sql: `
      -- Welcher Sprint-Tag ausgerollt wurde und welche Migrationen seit dem vorherigen Tag hinzukamen (NULL = unbekannt).
      ALTER TABLE production_deploys ADD COLUMN IF NOT EXISTS sprint_tag TEXT;
      ALTER TABLE production_deploys ADD COLUMN IF NOT EXISTS new_migrations TEXT[];
      -- Läuft gerade ein Deploy? Gesetzt zu Beginn von deployProject, am Ende wieder gelöscht.
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS deploy_started_at TIMESTAMPTZ;
      -- Rollback-Protokoll: von einem Menschen bestätigt, vom Worker über den normalen Deploy-Pfad ausgeführt.
      CREATE TABLE IF NOT EXISTS production_rollbacks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE ON UPDATE CASCADE,
        bug_id UUID REFERENCES bugs(id) ON DELETE SET NULL,
        from_tag TEXT NOT NULL,
        to_tag TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'running', 'succeeded', 'failed')),
        result TEXT,
        requested_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ
      );
      -- Höchstens ein offener Rollback je Projekt: ein zweiter Klick startet keinen zweiten Deploy.
      CREATE UNIQUE INDEX IF NOT EXISTS production_rollbacks_open_idx ON production_rollbacks (project_slug)
        WHERE status IN ('requested', 'running');
      CREATE INDEX IF NOT EXISTS production_rollbacks_bug_idx ON production_rollbacks (bug_id, created_at DESC);
    `,
  },
  // Log-Scan: zuletzt vermerkte Lücke, wenn der letzte erfolgreiche Scan länger als das längste Fenster her war.
  {
    version: 6,
    name: 'production-log-gap',
    sql: 'ALTER TABLE production_status ADD COLUMN IF NOT EXISTS log_gap TEXT;',
  },
  // Sitzungen an die Zugangsdaten binden (Passwortwechsel beendet sie) und für Bereinigung und Abfragen indizieren.
  // Sitzungen von vorher haben keine Bindung und gelten nicht mehr (fail-closed): einmal neu anmelden.
  {
    version: 7,
    name: 'auth-sessions-bindung',
    sql: `
      ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS credential_version TEXT;
      CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id);
      CREATE INDEX IF NOT EXISTS auth_sessions_expires_idx ON auth_sessions (expires_at);
      DELETE FROM auth_sessions WHERE credential_version IS NULL;
    `,
  },
  // Bugs zu einem Auftrag (Fehlschlag eines Agents, Problemanalyse) kommen auf den Friedhof, sobald der Auftrag
  // erledigt ist – alle, nicht nur der zuletzt in failure_bug_id vermerkte. Bestehende Meldungen werden über
  // failure_bug_id bzw. den Auftragstitel im Text („Aufgetreten bei Auftrag „…““, „Tester: <Titel>“) verknüpft.
  {
    version: 8,
    name: 'bugs-zum-auftrag-auf-den-friedhof',
    sql: `
      ALTER TABLE bugs ADD COLUMN IF NOT EXISTS development_id UUID REFERENCES development_items(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS bugs_development_idx ON bugs (development_id) WHERE development_id IS NOT NULL;

      UPDATE bugs b SET development_id = d.id FROM development_items d
       WHERE d.failure_bug_id = b.id AND b.development_id IS NULL;
      UPDATE bugs b SET development_id = (
          SELECT d.id FROM development_items d
           WHERE d.project_slug = b.project_slug AND d.kind <> 'express' AND (
                 b.description LIKE 'Aufgetreten bei Auftrag „' || d.title || '“%'
              OR substring(b.title FROM position(': ' IN b.title) + 2) = d.title
              OR (b.title LIKE '%…' AND position(': ' IN b.title) > 0
                  AND left(d.title, char_length(rtrim(substring(b.title FROM position(': ' IN b.title) + 2), '…')))
                      = rtrim(substring(b.title FROM position(': ' IN b.title) + 2), '…')))
           ORDER BY d.created_at DESC LIMIT 1)
       WHERE b.development_id IS NULL AND b.source = 'agent';

      CREATE OR REPLACE FUNCTION development_items_sync_bug() RETURNS trigger AS $fn$
      BEGIN
        IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'done' THEN
          -- Behebungsauftrag erledigt oder Auftrag mit Fehlschlag-Meldungen doch noch fertig: auf den Friedhof.
          UPDATE bugs SET status = 'fixed', fixed_at = NOW(), updated_at = NOW()
           WHERE (id = NEW.bug_id OR id = NEW.failure_bug_id OR development_id = NEW.id)
             AND status IN ('open', 'in_progress');
        ELSIF NEW.bug_id IS NOT NULL AND OLD.status IS DISTINCT FROM NEW.status THEN
          IF NEW.status = 'in_progress' THEN
            UPDATE bugs SET status = 'in_progress', updated_at = NOW() WHERE id = NEW.bug_id AND status = 'open';
          ELSIF NEW.status = 'rejected' THEN
            UPDATE bugs SET status = 'rejected', updated_at = NOW() WHERE id = NEW.bug_id AND status IN ('open', 'in_progress');
          ELSIF NEW.status IN ('planned', 'backlog', 'blocked') THEN
            UPDATE bugs SET status = 'open', updated_at = NOW() WHERE id = NEW.bug_id AND status = 'in_progress';
          END IF;
        END IF;
        RETURN NULL;
      END;
      $fn$ LANGUAGE plpgsql;

      -- Aufräumen: Meldungen, deren Auftrag schon erledigt ist.
      UPDATE bugs b SET status = 'fixed', fixed_at = NOW(), updated_at = NOW(),
             fix_notes = concat_ws(E'\\n\\n', NULLIF(b.fix_notes, ''), 'Auftrag inzwischen erledigt – automatisch auf den Friedhof.')
        FROM development_items d
       WHERE b.status IN ('open', 'in_progress') AND d.status = 'done'
         AND (d.id = b.development_id OR d.failure_bug_id = b.id);
      -- Meldung „CI rot im Pull Request von „Sprint …““, deren Sprint inzwischen gemergt ist.
      UPDATE bugs b SET status = 'fixed', fixed_at = NOW(), updated_at = NOW()
        FROM sprints s
       WHERE b.status IN ('open', 'in_progress') AND b.source = 'github' AND s.project_slug = b.project_slug
         AND s.status = 'completed' AND s.git_sync = 'done' AND b.title = 'CI rot im Pull Request von „' || s.name || '“';
    `,
  },
  // Schätzungen in Agent-Stunden: woher ein Wert stammt (von Hand, Schnellschätzung, Auftragsautor; NULL = Altbestand
  // in Menschenstunden), damit der Planer jede Herkunft getrennt kalibriert und der Autor nur Maschinenwerte ersetzt.
  // Die Sprint-Kapazität zählt jetzt Agent-Stunden; der alte Standard 40 (Menschenstunden) wird zu 4.
  {
    version: 9,
    name: 'schaetzung-in-agent-stunden',
    sql: `
      ALTER TABLE ideation_items ADD COLUMN IF NOT EXISTS estimate_source TEXT
        CHECK (estimate_source IN ('manual', 'quick', 'author'));
      ALTER TABLE development_items ADD COLUMN IF NOT EXISTS estimate_source TEXT
        CHECK (estimate_source IN ('manual', 'quick', 'author'));
      -- Altbestand unter 1 h stammt schon vom Auftragsautor mit Ist-Werten (gemessen: Ist ÷ Schätzung im Median
      -- 0,79 statt 0,02–0,08 bei grösseren Werten) und wird wie eine Autorschätzung kalibriert; der Rest bleibt NULL.
      UPDATE ideation_items SET estimate_source = 'author' WHERE estimate_source IS NULL AND effort_hours < 1;
      UPDATE development_items SET estimate_source = 'author' WHERE estimate_source IS NULL AND effort_hours < 1;
      ALTER TABLE projects ALTER COLUMN sprint_capacity_hours SET DEFAULT 4;
      UPDATE projects SET sprint_capacity_hours = 4 WHERE sprint_capacity_hours = 40;
    `,
  },
  // Unterbrochene Schritte (Worker beendet, Ordner weg, Nutzungslimit) bleiben „failed“, tragen aber ein eigenes
  // Kennzeichen: Der nächste Lauf setzt beim selben Agent fort statt wie nach einer Ablehnung beim Entwickler.
  // Bestehende Schritte erkennt einmalig die bisher angehängte Zeile „Unterbrochen: …“.
  {
    version: 10,
    name: 'agent-run-steps-unterbrochen',
    sql: `
      ALTER TABLE agent_run_steps ADD COLUMN IF NOT EXISTS interrupted BOOLEAN NOT NULL DEFAULT FALSE;
      UPDATE agent_run_steps SET interrupted = TRUE
       WHERE status = 'failed' AND NOT interrupted AND output LIKE E'%\\nUnterbrochen: %';
    `,
  },
  // Abgelehnter Bug-Auftrag erneut versucht: Der Bug folgt dem Auftrag wieder (rejected → open/in_progress) und wird
  // beim Erledigen auch aus rejected heraus behoben. Nur der eigene Bug (bug_id); Fehlschlag-Meldungen, die jemand
  // abgelehnt hat, bleiben abgelehnt. Altfälle (Auftrag erledigt, Bug noch abgelehnt) einmalig nachziehen.
  {
    version: 11,
    name: 'bug-folgt-erneut-versuchtem-auftrag',
    sql: `
      CREATE OR REPLACE FUNCTION development_items_sync_bug() RETURNS trigger AS $fn$
      BEGIN
        IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'done' THEN
          -- Behebungsauftrag erledigt oder Auftrag mit Fehlschlag-Meldungen doch noch fertig: auf den Friedhof.
          UPDATE bugs SET status = 'fixed', fixed_at = NOW(), updated_at = NOW()
           WHERE (id = NEW.bug_id OR id = NEW.failure_bug_id OR development_id = NEW.id)
             AND (status IN ('open', 'in_progress') OR (id = NEW.bug_id AND status = 'rejected'));
        ELSIF NEW.bug_id IS NOT NULL AND OLD.status IS DISTINCT FROM NEW.status THEN
          IF NEW.status = 'in_progress' THEN
            UPDATE bugs SET status = 'in_progress', updated_at = NOW()
             WHERE id = NEW.bug_id AND (status = 'open' OR (status = 'rejected' AND OLD.status = 'rejected'));
          ELSIF NEW.status = 'rejected' THEN
            UPDATE bugs SET status = 'rejected', updated_at = NOW() WHERE id = NEW.bug_id AND status IN ('open', 'in_progress');
          ELSIF NEW.status IN ('planned', 'backlog', 'blocked') THEN
            -- Abgelehnter Auftrag wieder eingeplant: Bug ist wieder offen.
            UPDATE bugs SET status = 'open', updated_at = NOW()
             WHERE id = NEW.bug_id AND (status = 'in_progress' OR (status = 'rejected' AND OLD.status = 'rejected'));
          END IF;
        END IF;
        RETURN NULL;
      END;
      $fn$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS development_items_bug_trigger ON development_items;
      CREATE TRIGGER development_items_bug_trigger AFTER UPDATE ON development_items
        FOR EACH ROW EXECUTE FUNCTION development_items_sync_bug();

      UPDATE bugs b SET status = 'fixed', fixed_at = COALESCE(d.completed_at, NOW()), updated_at = NOW(),
             fix_notes = concat_ws(E'\\n\\n', NULLIF(b.fix_notes, ''), 'Auftrag nach erneutem Versuch erledigt – automatisch auf den Friedhof.')
        FROM development_items d
       WHERE d.bug_id = b.id AND d.status = 'done' AND b.status = 'rejected';
    `,
  },
  // Sprint-Abbruch setzt Aufträge in Freigabe jetzt ins Backlog zurück (cancelSprint). Altfälle hängen ohne Sprint in
  // Freigabe fest – ihre Freigabe mergte in den toten Sprint-Branch, „Wieder einplanen“ scheiterte mit 409.
  {
    version: 12,
    name: 'freigabe-nach-sprint-abbruch-ins-backlog',
    sql: `
      UPDATE development_items SET status = 'backlog', review_branch = NULL, review_base = NULL, review_since = NULL,
             review_approved_at = NULL, updated_at = NOW()
       WHERE status = 'approval' AND sprint_id IS NULL AND removed_from_sprint_at IS NOT NULL;
    `,
  },
  // Sprint-Branch beim Start festhalten statt bei jedem Zugriff aus dem (per PATCH änderbaren, nicht eindeutigen)
  // Namen zu bilden: Nach einer Umbenennung zweigte sonst ein neuer Branch von main ab, und beim Abschluss kam nur der
  // Teil danach nach main. sprint_branch_slug entspricht slugify() in git-helpers.ts (Marken vor lower() entfernt,
  // damit es unabhängig von der Collation gleich bleibt). Altdaten: Laufende Sprints behalten ihren heutigen Branch;
  // bei gleichem Namen („Sprint 5“ doppelt) bekommen die übrigen die ersten sechs Zeichen ihrer ID angehängt.
  {
    version: 13,
    name: 'sprint-branch-beim-start-festhalten',
    sql: `
      ALTER TABLE sprints ADD COLUMN IF NOT EXISTS branch TEXT;
      CREATE OR REPLACE FUNCTION sprint_branch_slug(p_name TEXT) RETURNS TEXT AS $fn$
        SELECT COALESCE(NULLIF(left(btrim(regexp_replace(lower(regexp_replace(normalize(p_name, NFKD),
                 '[\\u0300-\\u036f\\u1ab0-\\u1aff\\u1dc0-\\u1dff\\u20d0-\\u20ff\\ufe20-\\ufe2f]', '', 'g')),
                 '[^a-z0-9]+', '-', 'g'), '-'), 40), ''), 'ohne-name')
      $fn$ LANGUAGE sql IMMUTABLE;
      CREATE OR REPLACE FUNCTION sprint_branch_for(p_project TEXT, p_id UUID, p_name TEXT) RETURNS TEXT AS $fn$
        SELECT CASE WHEN EXISTS (SELECT 1 FROM sprints WHERE project_slug = p_project AND id <> p_id
                                  AND branch = 'sprint/' || sprint_branch_slug(p_name))
               THEN 'sprint/' || sprint_branch_slug(p_name) || '-' || left(p_id::text, 6)
               ELSE 'sprint/' || sprint_branch_slug(p_name) END
      $fn$ LANGUAGE sql STABLE;

      WITH ranked AS (
        SELECT id, 'sprint/' || sprint_branch_slug(name) AS plain,
               row_number() OVER (PARTITION BY project_slug, sprint_branch_slug(name)
                                  ORDER BY status IN ('active', 'review') DESC, created_at DESC, id) AS rank
          FROM sprints WHERE branch IS NULL AND status <> 'planned'
      )
      UPDATE sprints s SET branch = CASE WHEN r.rank = 1 AND NOT EXISTS (
                 SELECT 1 FROM sprints o WHERE o.project_slug = s.project_slug AND o.branch = r.plain)
               THEN r.plain ELSE r.plain || '-' || left(s.id::text, 6) END
        FROM ranked r WHERE s.id = r.id;
      CREATE UNIQUE INDEX IF NOT EXISTS sprints_branch_idx ON sprints (project_slug, branch) WHERE branch IS NOT NULL;

      -- Beim Start (jeder Status ausser „geplant“) einmal vergeben; spätere Umbenennungen ändern ihn nicht mehr.
      CREATE OR REPLACE FUNCTION sprints_fix_branch() RETURNS trigger AS $fn$
      BEGIN
        IF NEW.status <> 'planned' AND NEW.branch IS NULL THEN
          NEW.branch := sprint_branch_for(NEW.project_slug, NEW.id, NEW.name);
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS sprints_fix_branch ON sprints;
      CREATE TRIGGER sprints_fix_branch BEFORE INSERT OR UPDATE OF status ON sprints
        FOR EACH ROW EXECUTE FUNCTION sprints_fix_branch();
    `,
  },
  // Sprint-Abschluss „wartet auf Merge“: main liegt in einem anderen Ordner mit offenen Änderungen, der Sprint ist noch
  // nicht in main. Früher hiess das „done“, der Autopilot startete den nächsten Sprint vom alten main. Der Worker setzt
  // „done“, sobald main den Sprint enthält (git merge-base --is-ancestor).
  {
    version: 14,
    name: 'sprint-wartet-auf-merge',
    sql: `
      ALTER TABLE sprints DROP CONSTRAINT IF EXISTS sprints_git_sync_check;
      ALTER TABLE sprints ADD CONSTRAINT sprints_git_sync_check
        CHECK (git_sync IN ('pending', 'running', 'done', 'failed', 'awaiting_merge'));
    `,
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
