import { logged } from '../core/log.js';
import { followLogFile } from '../core/log-file.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { beginShutdown, setProcessStore } from '../core/shutdown.js';
import { shareTreeLocks } from '../core/project-lock.js';
import { databaseProcessStore, killPreviousProcesses, RECLAIMABLE_RUN_SQL } from './process-registry.js';
import { currentWorkerId, setWorkerId, WORKER_STALE_SECONDS, workerIdFor } from './worker-identity.js';
import { seedProjectDefaults } from '../agent/default-agents.js';
import { createDatabasePool, readDatabaseConfig } from '../db/database.js';
import { loadInstallEnv, readEnvValues, requireDatabaseUrl } from '../core/local-database.js';
import { runCommand } from '../core/command.js';
import { removeLeftoverContainers } from '../core/sandbox.js';
import { stopLeftoverWorkbenchRuns } from '../core/workbench.js';
import { AGENT_RUN_STATUS, AGENT_STEP_STATUS, DEVELOPMENT_STATUS, IDEATION_STATUS } from '../core/status.js';
import { parseRunnerOptions, recoverStuckItems, type RunnerOptions } from './runner.js';
import { recoverTestRequests } from './test-request.js';
import { completeRestart } from './system-restart.js';
import { runWorker } from './worker-loop.js';
import { describeError } from './worker-log.js';
import { INSTALL_ROOT, resolveTargets, runProjectOnce, workerBeat } from './worker-targets.js';

/**
 * Projektbereich des Workers: aus der Umgebung, sonst aus der .env der Installation, sonst der Ordner, in dem
 * AIdeation selbst liegt (z. B. /Volumes/External). Ausserhalb davon legt der Worker nichts an und startet keine Agents.
 */
export function resolveProjectScope(environment: NodeJS.ProcessEnv, installDir: string): string {
  const configured = environment.DEV_LOG_PROJECT_ROOTS?.trim();
  if (configured) return configured;
  return readEnvValues(installDir).get('DEV_LOG_PROJECT_ROOTS')?.trim() || dirname(installDir);
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function connect(watch: boolean): Promise<Pool> {
  for (;;) {
    try {
      const pool = await createDatabasePool(readDatabaseConfig());
      await seedProjectDefaults(pool);
      return pool;
    } catch (error) {
      if (!watch) {
        throw error;
      }
      console.error(
        'Datenbank nicht erreichbar, neuer Versuch in 15 s:',
        error instanceof Error ? error.message : error,
      );
      await sleep(15_000);
    }
  }
}

/** Schlüssel der Datenbank-Sperre „ein Dauer-Worker für alle Projekte“ (beliebig, aber fest). */
const WORKER_LOCK_KEY = 727_402;

/**
 * Nimmt die Worker-Sperre auf einer eigenen Verbindung, die bis zum Ende offen bleibt (endet der Prozess, endet die
 * Sperre). Liefert die Freigabe oder null, wenn ein anderer Worker die Sperre hält. Die Freigabe muss vor pool.end()
 * laufen: pool.end() wartet auf jede ausgeliehene Verbindung – sonst hing der Worker nach dem Neubau, bis ihn die
 * Notbremse nach einer Minute beendete.
 */
export async function holdWorkerLock(pool: Pool): Promise<(() => Promise<void>) | null> {
  const client = await pool.connect();
  // Bricht die Verbindung ab (Datenbank-Neustart), darf das den Worker nicht beenden; die Sperre ist dann frei.
  const lost = (error: Error): void => console.warn('Worker-Sperre: Verbindung getrennt –', error.message);
  client.on('error', lost);
  const held = (await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [WORKER_LOCK_KEY])).rows[0]
    ?.ok;
  if (!held) {
    client.off('error', lost);
    client.release();
    return null;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [WORKER_LOCK_KEY]);
      client.off('error', lost);
      client.release();
    } catch (error) {
      // Verbindung verwerfen statt zurückgeben: Mit ihr endet auch die Sperre.
      client.off('error', lost);
      client.release(error instanceof Error ? error : true);
    }
  };
}

/**
 * Räumt beim Start nur eigene Läufe (Vorgänger mit derselben Worker-ID) und verwaiste (Worker ohne frisches
 * Lebenszeichen) auf. Läuft daneben ein anderer Worker, bleiben seine Läufe, Schritte und Prozesse unberührt; Anfragen
 * ohne Besitzer (Chat, Autor, Visionär, Analysen, Testanforderungen, Abnahmen, Git-Lösungen) bleiben dann ebenfalls
 * stehen, weil sie dem lebenden Worker gehören könnten.
 */
export async function recoverInterruptedRuns(
  pool: Pool,
  workerId: string | null = currentWorkerId(),
  kill?: Parameters<typeof killPreviousProcesses>[1],
): Promise<void> {
  const others = workerId
    ? await pool.query<{ id: string }>(
        `SELECT id FROM runner_workers w WHERE w.id <> $1 AND w.last_seen > NOW() - $2 * INTERVAL '1 second'`,
        [workerId, WORKER_STALE_SECONDS],
      )
    : { rows: [] };
  const alone = others.rows.length === 0;
  if (!alone) {
    console.info(
      `Weitere Worker aktiv (${others.rows.map((row) => row.id).join(', ')}): nur eigene und verwaiste Läufe werden aufgeräumt.`,
    );
  }
  if (alone) {
    // Angefangene Komplettläufe (Testanforderungen) gelten nach dem Neustart als abgebrochen.
    await recoverTestRequests(pool).catch(logged('runner-cli'));
    // Unterbrochene Abnahme-Prüfungen werden erneut angefragt.
    await pool
      .query(`UPDATE acceptance_checks SET status = 'verifying' WHERE status = 'checking'`)
      .catch(logged('runner-cli'));
  }
  // Erst alle Altprozesse beenden (Agent-Schritte, Chat, Autor, Visionär, Testanforderungen), dann neu einplanen.
  // Lebt einer womöglich noch, liefe die Anfrage sonst doppelt: dann nichts automatisch neu starten.
  const orphans = await killPreviousProcesses(pool, kill, workerId);
  const safe = orphans.failed === 0;
  // Läufe, die dieser Worker aufräumen darf – einmal festgehalten, damit Neueinplanen, Schritte und Läufe dieselben treffen.
  const runs = (
    await pool.query<{ id: string }>(
      `SELECT r.id FROM agent_runs r WHERE r.status = '${AGENT_RUN_STATUS.running}' AND ${RECLAIMABLE_RUN_SQL}`,
      [workerId, WORKER_STALE_SECONDS],
    )
  ).rows.map((row) => row.id);
  const requeued = safe
    ? await pool.query(
        `UPDATE development_items SET status = '${DEVELOPMENT_STATUS.planned}', updated_at = NOW()
          WHERE status = '${DEVELOPMENT_STATUS.inProgress}' AND id IN (SELECT development_id FROM agent_runs WHERE id = ANY($1::uuid[]))`,
        [runs],
      )
    : { rowCount: 0 };
  if (alone) {
    // Aufträge „In Arbeit“ ohne laufenden Lauf hängen (auch nach einem erfolgreichen Lauf ohne Abschluss): blockieren,
    // damit sie erneut gestartet werden können.
    await recoverStuckItems(pool, null);
    await pool.query(`DELETE FROM chat_messages WHERE role = 'assistant' AND status = 'processing'`);
    await pool.query(`UPDATE chat_messages SET status = $1 WHERE status = 'processing'`, [safe ? 'pending' : 'failed']);
    await pool.query(`UPDATE development_items SET analysis_status = 'requested' WHERE analysis_status = 'running'`);
    await pool.query(
      `UPDATE ideation_items SET status = '${IDEATION_STATUS.requested}', updated_at = NOW() WHERE status = '${IDEATION_STATUS.drafting}'`,
    );
    await pool
      .query(
        `UPDATE visionary_runs SET status = 'requested', started_at = NULL, progress = NULL WHERE status = 'running'`,
      )
      .catch(logged('runner-cli'));
  }
  await pool.query(
    `UPDATE agent_run_steps SET status = '${AGENT_STEP_STATUS.failed}', interrupted = TRUE,
            output = output || E'\nUnterbrochen: Der Worker wurde beendet.'
      WHERE status = '${AGENT_STEP_STATUS.running}' AND run_id = ANY($1::uuid[])`,
    [runs],
  );
  await pool.query(
    `UPDATE agent_runs SET status = '${AGENT_RUN_STATUS.failed}', completed_at = NOW() WHERE status = '${AGENT_RUN_STATUS.running}' AND id = ANY($1::uuid[])`,
    [runs],
  );
  if (alone) {
    // Eine laufende Git-Lösung endet mit dem Worker; „läuft“ bliebe sonst stehen und sperrte jede weitere Anfrage (409).
    await pool
      .query(
        `UPDATE git_fix_requests SET status = 'failed', finished_at = NOW(),
                message = 'Durch einen Neustart des Workers unterbrochen – bitte den Git-Zustand prüfen und erneut anfordern.'
          WHERE status = 'running'`,
      )
      .catch(logged('runner-cli'));
  }
  if (requeued.rowCount) console.info(`${requeued.rowCount} unterbrochene Aufträge werden erneut aufgenommen.`);
}

/** Ordner, aus dem dieser Worker läuft (die AIdeation-Installation). */

/** Bereinigt, was ein Vorgänger hinterliess, und plant unterbrochene Aufträge neu – bevor dieser Worker Arbeit annimmt. */
async function cleanUpPredecessor(pool: Pool, workerId: string): Promise<void> {
  // Vor dem Neueinplanen: Läufe des Vorgängers in den Arbeitscontainern beenden. Sonst arbeitete der alte Agent (oder
  // npm) neben dem neu eingeplanten im selben Worktree weiter; ohne Docker geschieht nichts.
  const stoppedRuns = await stopLeftoverWorkbenchRuns(runCommand, INSTALL_ROOT).catch(() => 0);
  if (stoppedRuns) console.info(`${stoppedRuns} übrig gebliebene Läufe in Arbeitscontainern beendet.`);
  await recoverInterruptedRuns(pool, workerId);
  // Sandbox-Container eines abgestürzten Vorgängers (Label aideation.run) entfernen; ohne Docker geschieht nichts.
  const leftovers = await removeLeftoverContainers(runCommand, INSTALL_ROOT).catch(() => 0);
  if (leftovers) console.info(`${leftovers} übrig gebliebene Sandbox-Container entfernt.`);
}

/** Ohne --watch: ein Arbeitszyklus je Projekt; liefert true, wenn ein Auftrag gescheitert ist. */
async function runAllOnce(pool: Pool, options: RunnerOptions): Promise<boolean> {
  let failed = false;
  for (const target of await resolveTargets(pool, options)) {
    if (target.problem) {
      console.error(`[${target.options.project}] ${target.problem}`);
      continue;
    }
    failed = (await runProjectOnce(pool, target.options)) || failed;
  }
  return failed;
}

/** Start des Workers: Umgebung, Datenbank, Worker-ID und Sperre; dann ein Zyklus oder der Dauerbetrieb (worker-loop). */
async function main(): Promise<void> {
  // Dienst (scripts/install-worker.sh): Log selbst schreiben, damit es nach der Rotation durch newsyslog weitergeht.
  const logFile = process.env.DEV_LOG_LOG_FILE?.trim();
  if (logFile) followLogFile(logFile);
  // Env-Datei des Dienstes (--env-file) vor der .env der Installation; ohne Datenbank-URL Abbruch statt Dauerschleife.
  loadInstallEnv(INSTALL_ROOT);
  requireDatabaseUrl();
  process.env.DEV_LOG_PROJECT_ROOTS = resolveProjectScope(process.env, INSTALL_ROOT);
  console.log(`Projektbereich: ${process.env.DEV_LOG_PROJECT_ROOTS}`);
  const options = parseRunnerOptions(process.argv.slice(2));
  const pool = await connect(options.watch);
  // Ordner-Sperre auch gegenüber anderen Workern (Host/Container, runner-cli ohne --all) über Postgres-Advisory-Locks.
  shareTreeLocks(pool);
  let stopping = false;
  const stop = (): void => {
    if (stopping) process.exit(1);
    stopping = true;
    beginShutdown();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // Worker-ID an Läufen und Prozessen, Lebenszeichen für die anderen Worker: Ein zweiter Worker räumt beim Start
  // nur eigene oder verwaiste Läufe auf. Ein einmaliger Lauf hat eine eigene ID, damit ihn kein Dauer-Worker beerbt.
  const scope = options.all ? 'alle' : options.project;
  const workerId = workerIdFor(process.env, INSTALL_ROOT, options.watch ? scope : `einmal:${scope}`);
  setWorkerId(workerId);
  const beat = workerBeat(pool, workerId);
  let releaseWorkerLock: (() => Promise<void>) | null = null;
  let registry: ReturnType<typeof databaseProcessStore> | null = null;
  try {
    if (!options.watch) {
      await beat.start();
      process.exitCode = (await runAllOnce(pool, options)) ? 1 : 0;
      return;
    }
    // Nur ein Dauer-Worker für alle Projekte: Ein zweiter (z. B. „npm run worker“ neben dem Dienst) setzte beim Start
    // die laufenden Aufträge des ersten zurück und führte sie doppelt aus. Die Sperre hält die Verbindung bis zum Ende.
    if (options.all) releaseWorkerLock = await holdWorkerLock(pool);
    if (options.all && !releaseWorkerLock) {
      console.error(
        'Ein anderer Worker für alle Projekte läuft bereits – dieser beendet sich, damit Aufträge nicht doppelt laufen.',
      );
      process.exitCode = 1;
      return;
    }
    // Erst nach der Sperre: Ein abgewiesener zweiter Worker soll nicht als lebender Worker gelten.
    await beat.start();
    await cleanUpPredecessor(pool, workerId);
    // Erst nach dem Aufräumen: ab jetzt landet jeder gestartete Prozess im Register (nur der Dauer-Worker, damit ein
    // einmaliger Lauf nicht beim nächsten Start als Altprozess gilt).
    registry = databaseProcessStore(pool);
    setProcessStore(registry);
    // Ein angeforderter Neustart („AIdeation neu starten“) ist mit diesem Start abgeschlossen.
    await completeRestart(pool).catch((error: unknown) =>
      console.error('Neustart-Status konnte nicht gesetzt werden:', describeError(error)),
    );
    await runWorker(pool, options, { stopping: () => stopping, stop });
  } finally {
    // Register abmelden, bevor der Pool schliesst: Prozesse, die erst danach enden, räumt der nächste Start auf
    // (killPreviousProcesses) – statt „Cannot use a pool after calling end on the pool“ zu melden.
    setProcessStore(null);
    beat.stop();
    await registry?.flush();
    await releaseWorkerLock?.();
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('Runner failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
