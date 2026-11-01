// Datenzugriff für Projekte (projects): alle SQL-Anweisungen der Projekt-Routen an einer Stelle.
import type { Pool } from 'pg';
import { encryptSecret, isEncrypted } from '../core/secrets.js';
import { AGENT_RUN_STATUS, IDEATION_STATUS } from '../core/status.js';
import { withTransaction } from './transaction.js';

/** Einstellungen des Produktions-Rückkanals; vom Ingest-Token nur, ob eines hinterlegt ist. */
export const PRODUCTION_COLUMNS = `health_url AS "healthUrl", log_services AS "logServices", production_ignore AS "productionIgnore", production_retention_days AS "productionRetentionDays", ingest_token_hash IS NOT NULL AS "ingestConfigured"`;

/** GitHub-Brücke: Modus, Freigabe-Option und der vom Worker geprüfte Anmeldestatus (kein Token). */
export const GITHUB_COLUMNS = `github_mode AS "githubMode", github_require_approval AS "githubRequireApproval",
  github_synced_at AS "githubSyncedAt", github_auth AS "githubAuth", github_auth_message AS "githubAuthMessage",
  github_auth_checked_at AS "githubAuthCheckedAt"`;

/** Visuelle Prüfung: Vorschau-Adresse, Seiten und Einstellungen. */
export const VISUAL_COLUMNS = `preview_url AS "previewUrl", preview_pages AS "previewPages", visual_settings AS "visualSettings"`;

/**
 * Spalten eines Projekts für die Oberfläche. Der Datenbank-Zugang erscheint nur als Ja/Nein, das Favicon nur als
 * Versionsstempel (die Datei liefert eine eigene Route).
 */
export const PROJECT_COLUMNS = `slug, name, repository, git_remote AS "gitRemote", database_url IS NOT NULL AS "databaseConfigured",
  test_commands AS "testCommands", order_test_commands AS "orderTestCommands", deploy_commands AS "deployCommands",
  deploy_status AS "deployStatus", description, guidelines, auto_bugfix AS "autoBugfix", agent_workspace AS "agentWorkspace",
  agent_sandbox AS "agentSandbox", review_mode AS "reviewMode", review_command AS "reviewCommand", review_url AS "reviewUrl",
  restart_after_sprint AS "restartAfterSprint", agent_permissions AS "agentPermissions",
  definition_of_ready AS "definitionOfReady", definition_of_done AS "definitionOfDone", sprint_mode AS "sprintMode",
  sprint_capacity_hours AS "sprintCapacityHours", autopilot_start AS "autopilotStart", autopilot_end AS "autopilotEnd",
  autopilot_days AS "autopilotDays", autopilot_auto_live AS "autopilotAutoLive", ${PRODUCTION_COLUMNS}, ${GITHUB_COLUMNS},
  ${VISUAL_COLUMNS}, created_at AS "createdAt", EXTRACT(EPOCH FROM favicon_mtime)::bigint AS "faviconVersion"`;

/** Zeile mit PROJECT_COLUMNS; die Routen geben sie unverändert als JSON weiter. */
export type ProjectRow = Record<string, unknown>;

/** Eine Spaltenzuweisung für UPDATE; `cast` hängt `::jsonb` bzw. `::smallint[]` an den Parameter. */
export interface ProjectAssignment {
  column: string;
  value: unknown;
  cast?: 'jsonb' | 'smallint[]';
}

/** Mit DEV_LOG_SECRET_KEY werden Datenbank-Zugänge aus der Zeit vor der Verschlüsselung beim Start einmal verschlüsselt. */
export async function encryptProjectSecrets(pool: Pool): Promise<number> {
  if (!process.env.DEV_LOG_SECRET_KEY?.trim()) return 0;
  const rows = (
    await pool.query<{ slug: string; url: string }>(
      'SELECT slug, database_url AS url FROM projects WHERE database_url IS NOT NULL',
    )
  ).rows.filter((row) => !isEncrypted(row.url));
  for (const row of rows) {
    await pool.query('UPDATE projects SET database_url = $2 WHERE slug = $1 AND database_url = $3', [
      row.slug,
      encryptSecret(row.url),
      row.url,
    ]);
  }
  return rows.length;
}

/** Mandantentrennung: null = Administrator (alle Projekte), sonst nur die freigeschalteten. */
export async function listProjects(pool: Pool, allowed: ReadonlySet<string> | null): Promise<ProjectRow[]> {
  const result = await pool.query<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS} FROM projects WHERE $1::text[] IS NULL OR slug = ANY($1) ORDER BY name`,
    [allowed ? [...allowed] : null],
  );
  return result.rows;
}

/** „Anmeldung prüfen“: Der Worker fragt `gh auth status` beim nächsten Takt erneut ab. Liefert die GitHub-Spalten. */
export async function resetGithubAuthCheck(pool: Pool, slug: string): Promise<ProjectRow | undefined> {
  const result = await pool.query<ProjectRow>(
    `UPDATE projects SET github_auth_checked_at = NULL WHERE slug = $1 RETURNING ${GITHUB_COLUMNS}`,
    [slug],
  );
  return result.rows[0];
}

export async function findProjectIdentity(
  pool: Pool,
  slug: string,
): Promise<{ name: string; repository: string } | undefined> {
  const result = await pool.query<{ name: string; repository: string }>(
    'SELECT name, repository FROM projects WHERE slug = $1',
    [slug],
  );
  return result.rows[0];
}

export async function findProjectGitRemote(pool: Pool, slug: string): Promise<string | null | undefined> {
  const result = await pool.query<{ remote: string | null }>(
    'SELECT git_remote AS remote FROM projects WHERE slug = $1',
    [slug],
  );
  return result.rows[0]?.remote;
}

/** Arbeitet gerade ein Agent am Projekt (laufender Lauf oder Auftragsautor beim Entwurf)? */
export async function agentWorking(pool: Pool, slug: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM agent_runs WHERE project_slug = $1 AND status = '${AGENT_RUN_STATUS.running}'
      UNION ALL SELECT 1 FROM ideation_items WHERE project_slug = $1 AND status = '${IDEATION_STATUS.drafting}' LIMIT 1`,
    [slug],
  );
  return result.rows.length > 0;
}

/**
 * Löscht das Projekt; mit `folderToDelete` entsteht in derselben Transaktion ein Auftrag an den Worker, den Ordner zu
 * löschen (scheitert das Löschen des Projekts, bleibt auch der Ordner). Liefert die ID dieses Auftrags.
 */
export async function deleteProject(pool: Pool, slug: string, folderToDelete: string | null): Promise<string | null> {
  return withTransaction(pool, async (client) => {
    const job = folderToDelete
      ? ((
          await client.query<{ id: string }>(
            `INSERT INTO setup_jobs (kind, params) VALUES ('delete_folder', $1::jsonb) RETURNING id`,
            [JSON.stringify({ path: folderToDelete })],
          )
        ).rows[0]?.id ?? null)
      : null;
    await client.query('DELETE FROM projects WHERE slug = $1', [slug]);
    return job;
  });
}

/** Git-Verlauf (Commits, Branches) fürs Dashboard, vom Worker erfasst. */
export async function findGitGraph(pool: Pool, slug: string): Promise<{ graph: unknown; updatedAt: Date } | undefined> {
  const result = await pool.query<{ graph: unknown; updatedAt: Date }>(
    'SELECT graph, updated_at AS "updatedAt" FROM project_git_graphs WHERE project_slug = $1',
    [slug],
  );
  return result.rows[0];
}

export async function findFavicon(
  pool: Pool,
  slug: string,
): Promise<{ favicon: Buffer | null; type: string | null } | undefined> {
  const result = await pool.query<{ favicon: Buffer | null; type: string | null }>(
    'SELECT favicon, favicon_type AS type FROM projects WHERE slug = $1',
    [slug],
  );
  return result.rows[0];
}

/** Setzt die geprüften Zuweisungen; liefert die aktualisierte Zeile oder undefined, wenn es das Projekt nicht gibt. */
export async function updateProject(
  pool: Pool,
  slug: string,
  assignments: readonly ProjectAssignment[],
): Promise<ProjectRow | undefined> {
  const values: unknown[] = [slug];
  const sets = assignments.map(({ column, value, cast }) => {
    values.push(value);
    return `${column} = $${values.length}${cast ? `::${cast}` : ''}`;
  });
  const result = await pool.query<ProjectRow>(
    `UPDATE projects SET ${sets.join(', ')} WHERE slug = $1 RETURNING ${PROJECT_COLUMNS}`,
    values,
  );
  return result.rows[0];
}

/** Legt das Projekt an; eine vergebene ID überschreibt nie Name und Ordner eines bestehenden Projekts (undefined). */
export async function createProject(
  pool: Pool,
  slug: string,
  name: string,
  repository: string,
): Promise<ProjectRow | undefined> {
  const result = await pool.query<ProjectRow>(
    `INSERT INTO projects (slug, name, repository)
     VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO NOTHING
     RETURNING slug, name, repository, created_at AS "createdAt"`,
    [slug, name, repository],
  );
  return result.rows[0];
}
