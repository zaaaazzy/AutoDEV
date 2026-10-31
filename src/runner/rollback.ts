import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { acquireTree, withProjectLock } from '../core/project-lock.js';
import { sendPush } from '../core/push.js';
import { completedSprintTags, DEPLOY_STALE_SQL, deployProject, deployRunning } from './deploy.js';
import { gitHelpers, previousSprintTag } from './git-sync.js';
import { AGENT_RUN_STATUS } from '../core/status.js';

/**
 * Rollback-Vorschlag nach einem kritischen Betriebsfehler: Liegt ein Ereignis des Bugs in den 30 Minuten nach einem
 * Deploy (deploy_suspect), bietet das Bug-Detail an, den unmittelbar vorherigen Sprint-Tag wieder auszurollen.
 * Ausgelöst wird nur nach Bestätigung durch einen Menschen; der Worker führt ihn über deployProject aus. Der Bug
 * bleibt dabei unverändert offen – ob er behoben ist, entscheidet ein Mensch.
 */

/** Gültige Sprint-Tags (wie sprintTag sie bildet); schützt Git-Aufrufe vor Optionen und Sonderzeichen. */
export const SPRINT_TAG = /^sprint-[a-z0-9][a-z0-9-]{0,80}$/;

export interface RollbackFacts {
  source: string;
  severity: string;
  /** Ein Ereignis des Bugs liegt im 30-Minuten-Fenster nach einem Deploy (deploy_suspect gesetzt). */
  deploySuspect: boolean;
  /** Letzter erfolgreicher Deploy des Projekts. */
  lastDeploy: { deployedAt: string; sprintTag: string | null; newMigrations: string[] | null } | null;
  /** Tags der abgeschlossenen Sprints, ältester zuerst. */
  tags: string[];
  deployRunning: boolean;
  deployCommands: boolean;
  /** Projektordner (Live) ist nicht der Arbeitsordner der Agents; nur dann darf ein Tag ausgecheckt werden. */
  separateFolder: boolean;
}

export interface RollbackProposal {
  /** Sprint-Tag des letzten Deploys. */
  fromTag: string | null;
  /** Unmittelbar davor liegender Sprint-Tag (Ziel). */
  toTag: string | null;
  deployedAt: string | null;
  /** Grund, warum der Knopf deaktiviert ist; null = auslösbar. */
  disabledReason: string | null;
  /** Migrationen, die der Zieltag nicht kennt; null = nicht prüfbar. */
  migrations: string[] | null;
}

/**
 * Entscheidet zentral über Knopf, Zieltag und Sperrgrund (für Oberfläche, API und jeden anderen Weg gleich).
 * null = kein Vorschlag (kein kritischer Betriebsbug oder kein Ereignis im Fenster nach einem Deploy).
 */
export function rollbackProposal(facts: RollbackFacts): RollbackProposal | null {
  if (facts.source !== 'production' || facts.severity !== 'critical' || !facts.deploySuspect) return null;
  const fromTag = facts.lastDeploy?.sprintTag ?? null;
  const toTag = previousSprintTag(facts.tags, fromTag);
  const disabledReason = !fromTag
    ? 'Der Sprint-Tag des letzten Deploys ist nicht bekannt.'
    : !toTag
      ? 'Kein vorheriger Sprint-Tag vorhanden.'
      : facts.deployRunning
        ? 'Es läuft bereits ein Deploy des Projekts.'
        : !facts.deployCommands
          ? 'Für das Projekt sind keine Deploy-Befehle hinterlegt.'
          : !facts.separateFolder
            ? 'Die Agents arbeiten im Projektordner; ein Tag-Checkout würde ihre Arbeit verändern. Eigenen Arbeitsordner für Agents einstellen.'
            : null;
  return {
    fromTag,
    toTag,
    deployedAt: facts.lastDeploy?.deployedAt ?? null,
    disabledReason,
    migrations: facts.lastDeploy?.newMigrations ?? null,
  };
}

/** Liest die Fakten zu einem Bug aus der Datenbank; null = Bug nicht gefunden. */
export async function loadRollbackFacts(
  pool: Pick<Pool, 'query'>,
  bugId: string,
): Promise<{ project: string; facts: RollbackFacts } | null> {
  const bug = (
    await pool.query<{
      project: string;
      source: string;
      severity: string;
      suspect: boolean;
      commands: boolean;
      separate: boolean;
    }>(
      `SELECT b.project_slug AS project, b.source, b.severity,
              EXISTS (SELECT 1 FROM production_events e
                       WHERE e.bug_id = b.id AND jsonb_typeof(e.deploy_suspect) = 'object') AS suspect,
              jsonb_typeof(p.deploy_commands) = 'array' AND jsonb_array_length(p.deploy_commands) > 0 AS commands,
              p.agent_workspace AS separate
         FROM bugs b JOIN projects p ON p.slug = b.project_slug WHERE b.id = $1`,
      [bugId],
    )
  ).rows[0];
  if (!bug) return null;
  const deploy = (
    await pool.query<{ deployedAt: Date; sprintTag: string | null; newMigrations: string[] | null }>(
      `SELECT deployed_at AS "deployedAt", sprint_tag AS "sprintTag", new_migrations AS "newMigrations"
         FROM production_deploys WHERE project_slug = $1 ORDER BY deployed_at DESC LIMIT 1`,
      [bug.project],
    )
  ).rows[0];
  return {
    project: bug.project,
    facts: {
      source: bug.source,
      severity: bug.severity,
      deploySuspect: Boolean(bug.suspect),
      lastDeploy: deploy
        ? {
            deployedAt: new Date(deploy.deployedAt).toISOString(),
            sprintTag: deploy.sprintTag,
            newMigrations: deploy.newMigrations,
          }
        : null,
      tags: await completedSprintTags(pool, bug.project),
      deployRunning: await deployRunning(pool, bug.project),
      deployCommands: Boolean(bug.commands),
      separateFolder: Boolean(bug.separate),
    },
  };
}

export const ROLLBACK_COLUMNS = `id, bug_id AS "bugId", from_tag AS "fromTag", to_tag AS "toTag", status, result,
  requested_by AS "requestedBy", created_at AS "createdAt", started_at AS "startedAt", finished_at AS "finishedAt"`;

/**
 * Checkt den Sprint-Tag im Projektordner aus (losgelöster HEAD). Nur in einem sauberen Ordner, der nicht auf einem
 * Auftrags-Branch steht; fehlt der Tag lokal, wird er einmal von origin geholt. Wirft mit deutschem Grund.
 */
export async function checkoutSprintTag(
  folder: string,
  tag: string,
  rawExecute: CommandExecutor = runCommand,
): Promise<void> {
  if (!SPRINT_TAG.test(tag)) throw new Error(`Ungültiger Sprint-Tag „${tag}“.`);
  if (!existsSync(join(folder, '.git'))) throw new Error(`${folder} ist kein Git-Repository.`);
  const execute: CommandExecutor = (command, directory, options) =>
    withProjectLock(folder, () => rawExecute(command, directory, options));
  const { git } = gitHelpers(execute, folder);
  const branch = await git('symbolic-ref', '--short', '-q', 'HEAD');
  if (branch.exitCode === 0 && branch.output.startsWith('auftrag/')) {
    throw new Error(`Im Projektordner ist der Auftrags-Branch ${branch.output} ausgecheckt.`);
  }
  if ((await git('status', '--porcelain', '--untracked-files=no')).output) {
    throw new Error(`Im Projektordner ${folder} sind Änderungen offen – erst sichern, dann erneut auslösen.`);
  }
  const ref = `refs/tags/${tag}`;
  const verify = () => git('rev-parse', '-q', '--verify', `${ref}^{commit}`);
  if ((await verify()).exitCode !== 0) {
    await git('fetch', '-q', 'origin', `+${ref}:${ref}`);
    if ((await verify()).exitCode !== 0) throw new Error(`Sprint-Tag ${tag} fehlt im Projektordner.`);
  }
  const moved = await git('checkout', '-q', '--detach', ref);
  if (moved.exitCode !== 0) throw new Error(`Checkout von ${tag} fehlgeschlagen: ${moved.output.slice(-300)}`);
}

interface ClaimedRollback {
  id: string;
  bugId: string | null;
  fromTag: string;
  toTag: string;
}

/**
 * Worker: nimmt einen bestätigten Rollback an und rollt den Zieltag über deployProject aus. Nicht neben laufenden
 * Agents (ein Deploy kann Dienste neu starten) und nicht neben einem anderen Deploy. Das Ergebnis steht immer mit
 * Text im Protokoll – auch, wenn kein einzelner Befehl gescheitert ist. Liefert true, wenn etwas zu tun war.
 */
export async function processRollback(
  pool: Pool,
  project: string,
  repository: string,
  agentFolder: string,
  execute: CommandExecutor = runCommand,
): Promise<boolean> {
  // Liegengebliebene Läufe (Worker während des Rollbacks beendet) abschliessen, damit der Knopf wieder frei wird.
  await pool.query(
    `UPDATE production_rollbacks SET status = 'failed', finished_at = NOW(),
            result = 'Abgebrochen: Der Worker wurde während des Rollbacks beendet. Deploy-Status des Projekts prüfen.'
      WHERE project_slug = $1 AND status = 'running' AND started_at < NOW() - ${DEPLOY_STALE_SQL}`,
    [project],
  );
  const claimed = (
    await pool.query<ClaimedRollback>(
      `UPDATE production_rollbacks SET status = 'running', started_at = NOW()
        WHERE id = (SELECT id FROM production_rollbacks WHERE project_slug = $1 AND status = 'requested'
                     ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
          AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE project_slug = $1 AND status = '${AGENT_RUN_STATUS.running}')
          AND NOT EXISTS (SELECT 1 FROM projects WHERE slug = $1 AND deploy_started_at > NOW() - ${DEPLOY_STALE_SQL})
        RETURNING id, bug_id AS "bugId", from_tag AS "fromTag", to_tag AS "toTag"`,
      [project],
    )
  ).rows[0];
  if (!claimed) return false;
  let ok = false;
  let result: string;
  try {
    if (repository === agentFolder) {
      throw new Error('Die Agents arbeiten im Projektordner; ein Tag-Checkout würde ihre Arbeit verändern.');
    }
    // Exklusiv im Projektordner: kein Assistent und keine Git-Lösung arbeitet währenddessen darin.
    const release = await acquireTree(repository);
    try {
      await checkoutSprintTag(repository, claimed.toTag, execute);
      const deployed = await deployProject(pool, project, repository, execute, { sprintTag: claimed.toTag });
      ok = deployed === true;
      result =
        deployed === true
          ? `Rollback von ${claimed.fromTag} auf ${claimed.toTag} ausgerollt. Der Projektordner steht jetzt auf ${claimed.toTag}; das nächste „Live schalten“ zieht ihn wieder auf main.`
          : deployed === null
            ? `Kein Deploy: Für das Projekt sind keine Deploy-Befehle hinterlegt. Der Projektordner steht auf ${claimed.toTag}.`
            : `Deploy auf ${claimed.toTag} fehlgeschlagen: ${await deployStatus(pool, project)}`;
    } finally {
      release();
    }
  } catch (error) {
    result = `Rollback auf ${claimed.toTag} fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`;
  }
  await pool.query(`UPDATE production_rollbacks SET status = $2, result = $3, finished_at = NOW() WHERE id = $1`, [
    claimed.id,
    ok ? 'succeeded' : 'failed',
    result.slice(0, 2000),
  ]);
  await sendPush(
    pool,
    {
      title: `${ok ? '↩︎' : '⚠️'} Rollback ${ok ? 'ausgerollt' : 'fehlgeschlagen'} · ${project}`,
      body: result.slice(0, 300),
      url: `#bugs?project=${encodeURIComponent(project)}`,
      tag: `rollback-${project}`,
    },
    { project },
  ).catch(() => undefined);
  return true;
}

async function deployStatus(pool: Pick<Pool, 'query'>, project: string): Promise<string> {
  const row = (
    await pool.query<{ status: string | null }>('SELECT deploy_status AS status FROM projects WHERE slug = $1', [
      project,
    ])
  ).rows[0];
  return row?.status?.trim() || 'Keine Fehlerausgabe des Deploys vorhanden.';
}
