import type { Pool } from 'pg';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { gitHelpers, previousSprintTag, sprintTag } from './git-sync.js';
import { recordDeploy } from './production-events.js';
import { scanLogs } from './production-monitor.js';
import { agentEnvironment } from './runner-prompts.js';

const DEPLOY_TIMEOUT_MS = 20 * 60_000;
/** Ein Deploy, der länger als so lange als laufend markiert ist, gilt als abgebrochen (z. B. Worker-Neustart). */
export const DEPLOY_STALE_SQL = `INTERVAL '2 hours'`;
/** Pfade, die nach Datenbankmigrationen aussehen (Ordner migrations/, migrate/, alembic/versions oder Dateiname). */
const MIGRATION_PATH = /(^|\/)(migrations?|migrate|alembic\/versions)\/|migration[^/]*$/i;

export interface DeployOptions {
  /** Sprint-Tag, der ausgerollt wird (Rollback); ohne Angabe der Tag des zuletzt abgeschlossenen Sprints. */
  sprintTag?: string;
}

/** Sprint-Tags der abgeschlossenen Sprints, ältester zuerst (Reihenfolge des Abschlusses). */
export async function completedSprintTags(pool: Pick<Pool, 'query'>, project: string): Promise<string[]> {
  const rows = (
    await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM sprints WHERE project_slug = $1 AND status = 'completed'
        ORDER BY COALESCE(git_synced_at, updated_at), created_at`,
      [project],
    )
  ).rows;
  return rows.map((row) => sprintTag(row.name, row.id));
}

/**
 * Läuft gerade ein Deploy des Projekts (normaler Deploy oder ein angeforderter bzw. laufender Rollback)? Gilt für
 * Oberfläche, API und Worker gleich; eine liegengebliebene Marke zählt nach DEPLOY_STALE_SQL nicht mehr.
 */
export async function deployRunning(pool: Pick<Pool, 'query'>, project: string): Promise<boolean> {
  const row = (
    await pool.query<{ running: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM projects WHERE slug = $1 AND deploy_started_at > NOW() - ${DEPLOY_STALE_SQL})
           OR EXISTS (SELECT 1 FROM production_rollbacks WHERE project_slug = $1 AND status IN ('requested', 'running'))
           AS running`,
      [project],
    )
  ).rows[0];
  return Boolean(row?.running);
}

/**
 * Migrationsdateien, die seit `previous` hinzukamen oder geändert wurden (Hinweis beim Rollback). null = nicht
 * prüfbar (kein vorheriger Tag, kein Git, Tag fehlt im Ordner).
 */
export async function migrationsSince(
  cwd: string,
  previous: string | null,
  execute: CommandExecutor = runCommand,
): Promise<string[] | null> {
  if (!previous) return null;
  const result = await gitHelpers(execute, cwd)
    .git('-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=AM', `refs/tags/${previous}`, 'HEAD', '--')
    .catch(() => null);
  if (!result || result.exitCode !== 0) return null;
  return result.output
    .split('\n')
    .map((line) => line.trim())
    .filter((path) => path && MIGRATION_PATH.test(path))
    .slice(0, 20);
}

/**
 * Runs the project's deploy commands (e.g. "docker compose up -d --build") so running containers match the code.
 * Auch der Rollback auf einen älteren Sprint-Tag läuft hierüber (`options.sprintTag`), mit denselben Befehlen.
 */
export async function deployProject(
  pool: Pool,
  project: string,
  cwd: string,
  execute: CommandExecutor = runCommand,
  options: DeployOptions = {},
): Promise<boolean | null> {
  const row = (
    await pool.query<{ commands: string[][] | null }>(
      `SELECT deploy_commands AS commands FROM projects WHERE slug = $1`,
      [project],
    )
  ).rows[0];
  const commands = row?.commands;
  if (!commands?.length) return null;
  const stamp = (): string => new Date().toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
  // „Deploy läuft“: sperrt in der Zeit den Rollback-Knopf (und einen zweiten Rollback).
  await pool.query(`UPDATE projects SET deploy_started_at = NOW() WHERE slug = $1`, [project]);
  try {
    for (const command of commands) {
      console.info(`[${project}] Deploy: ${command.join(' ')}`);
      const result = await execute(command, cwd, { timeoutMs: DEPLOY_TIMEOUT_MS, env: agentEnvironment() }).catch(
        (error: unknown) => ({ exitCode: 1, output: error instanceof Error ? error.message : String(error) }),
      );
      if (result.exitCode !== 0) {
        const tail = result.output.trim().split('\n').slice(-3).join(' ').slice(0, 300);
        await pool.query(`UPDATE projects SET deploy_status = $2 WHERE slug = $1`, [
          project,
          `Fehlgeschlagen um ${stamp()}: ${command.join(' ')} – ${tail}`,
        ]);
        return false;
      }
    }
  } finally {
    await pool
      .query(`UPDATE projects SET deploy_started_at = NULL WHERE slug = $1`, [project])
      .catch((error: unknown) => console.error(`[${project}] Deploy-Marke nicht gelöscht:`, error));
  }
  await pool.query(`UPDATE projects SET deploy_status = $2 WHERE slug = $1`, [project, `Aktualisiert um ${stamp()}`]);
  // Produktions-Rückkanal: Deploy-Zeitpunkt (für den Deploy-Verdacht) und den ausgerollten Sprint-Tag festhalten
  // (für den Rollback-Vorschlag), dann sofort die Logs prüfen.
  await (async () => {
    const tags = await completedSprintTags(pool, project);
    const tag = options.sprintTag ?? tags.at(-1) ?? null;
    const newMigrations = await migrationsSince(cwd, previousSprintTag(tags, tag), execute);
    await recordDeploy(pool, project, { sprintTag: tag, newMigrations });
  })().catch((error: unknown) => console.error(`[${project}] Deploy konnte nicht festgehalten werden:`, error));
  await scanLogs(pool, project, cwd, execute).catch((error: unknown) =>
    console.error(`[${project}] Log-Scan nach dem Deploy fehlgeschlagen:`, error),
  );
  return true;
}
