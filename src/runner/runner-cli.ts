import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { processChat, rejectChat } from '../agent/chat.js';
import { beginShutdown, killOrphan } from '../core/shutdown.js';
import { createDatabasePool, readDatabaseConfig } from '../db/database.js';
import { beatHeartbeat, readMaxAgents } from '../api/worker.js';
import { publishSystemAgents } from '../agent/system-agents.js';
import { processSetupJob } from '../setup/setup-jobs.js';
import { missingFolderMessage, volumeOf, watchFolders } from '../core/folder-guard.js';
import { projectFolderError } from '../core/validation.js';
import { resolveAgentWorkspace } from './agent-workspace.js';
import { ReviewSlots } from './review-slots.js';
import { syncSprintCommits } from './sprint-commits.js';

const SETUP_PARALLEL = 4;
import { draftRequirements } from '../agent/requirements.js';
import { commentSprintProposal } from '../agent/sprint-comment.js';
import { processVisionaryRun } from '../agent/visionary.js';
import { syncFavicon } from './favicon.js';
import { syncGitGraph } from './git-graph.js';
import { estimateNewIdeas } from '../agent/estimation.js';
import { parseRunnerOptions, runWorkflow, type RunnerOptions } from './runner.js';
import { analyzeBlocked } from '../agent/troubleshoot.js';
import { verifyAcceptance } from './verify-acceptance.js';
import { processTestRequest, recoverTestRequests } from './test-request.js';
import { completeRestart, processRestart, readRestart } from './system-restart.js';
import { sendPush } from '../core/push.js';
import { listenForWork, WorkSignal } from './work-signal.js';

/**
 * Projektbereich des Workers: aus der Umgebung, sonst aus der .env der Installation, sonst der Ordner, in dem
 * Dev Log selbst liegt (z. B. /Volumes/External). Ausserhalb davon legt der Worker nichts an und startet keine Agents.
 */
export function resolveProjectScope(environment: NodeJS.ProcessEnv, installDir: string): string {
  const configured = environment.DEV_LOG_PROJECT_ROOTS?.trim();
  if (configured) return configured;
  try {
    const line = readFileSync(resolve(installDir, '.env'), 'utf8')
      .split(/\r?\n/)
      .find((entry) => entry.startsWith('DEV_LOG_PROJECT_ROOTS='));
    const value = line
      ?.slice('DEV_LOG_PROJECT_ROOTS='.length)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (value) return value;
  } catch {
    // keine .env – Vorgabe unten
  }
  return dirname(installDir);
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function connect(watch: boolean): Promise<Pool> {
  for (;;) {
    try {
      return await createDatabasePool(readDatabaseConfig());
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

const loggedErrors = new Map<string, string>();

/** pg liefert bei ausgefallener Datenbank AggregateErrors ohne Text; der Code (z. B. ECONNREFUSED) ist dann die einzige Information. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: string }).code;
  return error.message || code || error.name;
}

/** Gleiche Fehlermeldungen pro Schlüssel nur einmal ausgeben, bis sie sich ändern oder der Fehler verschwindet. */
function logOnce(key: string, message: string): void {
  if (loggedErrors.get(key) === message) return;
  loggedErrors.set(key, message);
  console.error(message);
}

async function runOnce(pool: Pool, options: RunnerOptions): Promise<boolean> {
  const results = await runWorkflow(pool, options);
  for (const { itemId, result } of results) {
    console.info(`${itemId}: ${result}`);
  }
  return results.some(({ result }) => result === 'failed');
}

interface Target {
  options: RunnerOptions;
  problem: string | null;
  /** Projektordner laut Projekt (für die Ausfall-Überwachung). */
  repository: string;
  /** Ordner fehlt nur vorübergehend (externes Laufwerk getrennt): Anfragen warten statt abgelehnt zu werden. */
  transient: boolean;
}

/** With --all every registered project is served from its own project folder (projects.repository). */
async function resolveTargets(pool: Pool, options: RunnerOptions): Promise<Target[]> {
  if (!options.all) {
    return [{ options, problem: null, repository: options.cwd, transient: false }];
  }
  const projects = await pool.query<{ slug: string; repository: string; separate: boolean }>(
    'SELECT slug, repository, agent_workspace AS separate FROM projects ORDER BY slug',
  );
  return Promise.all(
    projects.rows.map(async ({ slug, repository, separate }) => {
      const outside = isAbsolute(repository) ? projectFolderError(repository) : null;
      const folder =
        !outside && isAbsolute(repository) && existsSync(repository) && statSync(repository).isDirectory()
          ? repository
          : null;
      // Der Dev-Log-Ordner selbst (oder ein Projekt mit eigenem Arbeitsordner): Agents arbeiten in einem eigenen
      // Worktree, nie im Arbeitsordner der Menschen bzw. des laufenden Entwicklungsservers.
      const workspace = folder ? await resolveAgentWorkspace(folder, INSTALL_ROOT, undefined, separate) : null;
      const transient = !outside && !folder && isAbsolute(repository) && volumeOf(repository) !== null;
      return {
        options: { ...options, project: slug, cwd: workspace?.cwd ?? folder ?? options.cwd },
        problem: outside
          ? `Projekt ausserhalb des Projektbereichs – Agents bleiben gestoppt: ${outside}`
          : transient
            ? missingFolderMessage(repository)
            : !folder
              ? `Projektordner nicht gefunden: ${repository} (im Dev Log unter „Projekt“ den absoluten Pfad angeben)`
              : (workspace?.problem ?? null),
        repository,
        transient,
      };
    }),
  );
}

const FOLDER_NOTICE_KEY = 'folder_outage_notified';
const FOLDER_NOTICE_PAUSE_MS = 10 * 60_000;
/** Zuletzt gemeldeter Ausfall je Laufwerk: ein wackelndes Kabel soll nicht jede Minute einen Push auslösen. */
const folderNotices = new Map<string, number>();

/** Push an die betroffenen Projekte, wenn ein Laufwerk wegfällt oder wiederkommt (je Laufwerk und Zustand einmal). */
async function notifyFolders(pool: Pool, targets: Target[], volume: string, back: boolean): Promise<void> {
  const last = folderNotices.get(volume);
  if (!back && last && Date.now() - last < FOLDER_NOTICE_PAUSE_MS) return;
  if (back && !last) return;
  if (back) folderNotices.delete(volume);
  else folderNotices.set(volume, Date.now());
  const name = volume.startsWith('/Volumes/') ? `Laufwerk „${volume.slice('/Volumes/'.length)}“` : volume;
  for (const target of targets.filter((entry) => entry.repository.startsWith(volume))) {
    await sendPush(
      pool,
      {
        title: back ? `✅ ${name} wieder verbunden` : `⚠️ ${name} getrennt`,
        body: back
          ? 'Die Agents arbeiten weiter; unterbrochene Aufträge und wartende Anfragen laufen erneut.'
          : 'Die Agents pausieren, bis der Projektordner wieder erreichbar ist. Kabel und Stromversorgung prüfen.',
        url: '#dashboard',
        tag: `${FOLDER_NOTICE_KEY}-${volume}`,
      },
      { project: target.options.project },
    ).catch(() => undefined);
  }
}

// Läufe, die beim Beenden oder Absturz des Workers noch liefen, werden beendet und wieder eingeplant.
async function recoverInterruptedRuns(pool: Pool): Promise<void> {
  // Angefangene Komplettläufe (Testanforderungen) gelten nach dem Neustart als abgebrochen.
  await recoverTestRequests(pool).catch(() => undefined);
  // Unterbrochene Abnahme-Prüfungen werden erneut angefragt.
  await pool
    .query(`UPDATE acceptance_checks SET status = 'verifying' WHERE status = 'checking'`)
    .catch(() => undefined);
  const orphans = await pool.query<{ pid: number; spawnedAt: Date }>(
    `SELECT pid, pid_started_at AS "spawnedAt" FROM agent_run_steps WHERE status = 'running' AND pid IS NOT NULL`,
  );
  for (const orphan of orphans.rows) {
    if (killOrphan(orphan.pid, orphan.spawnedAt)) console.info(`Verwaisten Agent-Prozess ${orphan.pid} beendet.`);
  }
  const requeued = await pool.query(
    `UPDATE development_items SET status = 'planned', updated_at = NOW()
      WHERE status = 'in_progress' AND id IN (SELECT development_id FROM agent_runs WHERE status = 'running')`,
  );
  // Orders left "in progress" without any running run would be stuck; a failed last run makes them retryable.
  await pool.query(
    `UPDATE development_items d SET status = 'blocked', updated_at = NOW()
      WHERE d.status = 'in_progress' AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.development_id = d.id AND r.status = 'running')
        AND (SELECT r.status FROM agent_runs r WHERE r.development_id = d.id ORDER BY r.started_at DESC LIMIT 1) = 'failed'`,
  );
  await pool.query(`DELETE FROM chat_messages WHERE role = 'assistant' AND status = 'processing'`);
  await pool.query(`UPDATE chat_messages SET status = 'pending' WHERE status = 'processing'`);
  await pool.query(`UPDATE development_items SET analysis_status = 'requested' WHERE analysis_status = 'running'`);
  await pool.query(`UPDATE ideation_items SET status = 'requested', updated_at = NOW() WHERE status = 'drafting'`);
  await pool
    .query(
      `UPDATE visionary_runs SET status = 'requested', started_at = NULL, progress = NULL WHERE status = 'running'`,
    )
    .catch(() => undefined);
  await pool.query(
    `UPDATE agent_run_steps SET status = 'failed', output = output || E'\nUnterbrochen: Der Worker wurde beendet.' WHERE status = 'running'`,
  );
  await pool.query(`UPDATE agent_runs SET status = 'failed', completed_at = NOW() WHERE status = 'running'`);
  if (requeued.rowCount) console.info(`${requeued.rowCount} unterbrochene Aufträge werden erneut aufgenommen.`);
}

/** Ordner, aus dem dieser Worker läuft (die Dev-Log-Installation). */
const INSTALL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function main(): Promise<void> {
  process.env.DEV_LOG_PROJECT_ROOTS = resolveProjectScope(process.env, INSTALL_ROOT);
  console.log(`Projektbereich: ${process.env.DEV_LOG_PROJECT_ROOTS}`);
  const options = parseRunnerOptions(process.argv.slice(2));
  const pool = await connect(options.watch);
  let stopping = false;
  const stop = (): void => {
    if (stopping) process.exit(1);
    stopping = true;
    beginShutdown();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    if (!options.watch) {
      const targets = await resolveTargets(pool, options);
      let failed = false;
      for (const target of targets) {
        if (target.problem) {
          console.error(`[${target.options.project}] ${target.problem}`);
          continue;
        }
        failed = (await runOnce(pool, target.options)) || failed;
      }
      process.exitCode = failed ? 1 : 0;
      return;
    }
    await recoverInterruptedRuns(pool);
    // Ein angeforderter Neustart („Dev Log neu starten“) ist mit diesem Start abgeschlossen.
    await completeRestart(pool).catch((error: unknown) =>
      console.error('Neustart-Status konnte nicht gesetzt werden:', describeError(error)),
    );
    const intervalSeconds = Math.round(options.intervalMs / 1000);
    console.info(
      `Worker gestartet (${options.all ? 'alle Projekte' : options.project}, Intervall ${intervalSeconds} s).`,
    );
    const errors = new Map<string, string | null>();
    let known: string[] = options.all ? [] : [options.project];
    let startup = true;
    const beat = (): void => {
      for (const slug of known) {
        void beatHeartbeat(pool, slug, intervalSeconds, errors.get(slug) ?? null, startup).catch(() => undefined);
      }
      if (known.length) startup = false;
    };
    void publishSystemAgents(pool).catch(() => undefined);
    // Favicons der Projekte alle 5 Minuten abgleichen (nur bei Änderung wird gespeichert).
    let faviconCheck = 0;
    // Git-Verlauf fürs Dashboard jede Minute.
    let gitCheck = 0;
    const heartbeat = setInterval(() => {
      beat();
      void publishSystemAgents(pool).catch(() => undefined);
      if (Date.now() - gitCheck > 60_000) {
        gitCheck = Date.now();
        for (const target of chatTargets) {
          if (target.problem) continue;
          void syncGitGraph(pool, target.options.project, target.options.cwd).catch(() => undefined);
          void syncSprintCommits(pool, target.options.project, target.options.cwd).catch(() => undefined);
        }
      }
      if (Date.now() - faviconCheck > 5 * 60_000) {
        faviconCheck = Date.now();
        for (const target of chatTargets) {
          if (target.problem) continue;
          void syncFavicon(pool, target.options.project, target.options.cwd).catch(() => undefined);
        }
      }
    }, 15_000);
    // Projektordner und Dev-Log-Ordner überwachen: Ausfälle (z. B. externes Laufwerk) melden und für Agent-Läufe merken,
    // damit ein Abbruch in dieser Zeit als Unterbrechung gilt statt als Fehler im Auftrag.
    const stopFolderWatch = watchFolders(
      () => [
        INSTALL_ROOT,
        ...chatTargets.flatMap((target) => [target.repository, target.options.cwd]).filter((path) => isAbsolute(path)),
      ],
      ({ lost, back }) => {
        const volumes = (paths: string[]) => [...new Set(paths.map((path) => volumeOf(path) ?? path))];
        for (const volume of volumes(lost)) {
          console.error(`[Ordner] nicht erreichbar: ${volume} – Agents pausieren.`);
          void notifyFolders(pool, chatTargets, volume, false);
        }
        for (const volume of volumes(back)) {
          console.info(`[Ordner] wieder erreichbar: ${volume}`);
          void notifyFolders(pool, chatTargets, volume, true);
        }
      },
    );
    // Einrichtungsassistent: Host-Aufgaben (Ordner, Git, GitHub, Vorlagen, Agent-Tests) schnell und parallel abarbeiten.
    let setupActive = 0;
    const setupTimer = setInterval(() => {
      if (setupActive >= SETUP_PARALLEL || stopping) return;
      setupActive += 1;
      void processSetupJob(pool)
        .catch((error: unknown) => logOnce('setup', `Einrichtungsaufgabe fehlgeschlagen: ${describeError(error)}`))
        .finally(() => (setupActive -= 1));
    }, 500);
    // Chat-Antworten laufen unabhängig von Aufträgen, damit der Assistent sofort reagiert.
    let chatTargets: Target[] = [];
    const chatActive = new Set<string>();
    const analysisActive = new Set<string>();
    const estimateActive = new Set<string>();
    const authorActive = new Set<string>();
    const commentActive = new Set<string>();
    const visionaryActive = new Set<string>();
    const testActive = new Set<string>();
    // Review-Container (projektübergreifend): angeforderte Stände starten, Freigaben zuweisen, Zustand prüfen.
    const reviewSlots = new ReviewSlots(pool, INSTALL_ROOT);
    let reviewActive = false;
    const reviewTimer = setInterval(() => {
      if (reviewActive || stopping) return;
      reviewActive = true;
      void reviewSlots
        .sync()
        .then(() => loggedErrors.delete('review'))
        .catch((error: unknown) => logOnce('review', `Review-Container fehlgeschlagen: ${describeError(error)}`))
        .finally(() => (reviewActive = false));
    }, 5_000);
    const chatTimer = setInterval(() => {
      for (const target of chatTargets) {
        const slug = target.options.project;
        // Kompletter Test auf Knopfdruck (Aktionen-Menü, Testläufe): unabhängig vom Chat, der sonst alles Weitere blockiert.
        if (!testActive.has(slug) && !stopping && !target.problem) {
          testActive.add(slug);
          void processTestRequest(pool, target.options)
            .catch((error: unknown) =>
              logOnce(`test:${slug}`, `[${slug}] Kompletter Test fehlgeschlagen: ${describeError(error)}`),
            )
            .finally(() => testActive.delete(slug));
        }
        if (chatActive.has(slug) || stopping) continue;
        if (target.problem) {
          // Laufwerk nur kurz weg: Anfragen bleiben wartend und laufen, sobald der Ordner wieder da ist.
          if (!target.transient) void rejectChat(pool, slug, target.problem).catch(() => undefined);
          continue;
        }
        if (!estimateActive.has(slug)) {
          estimateActive.add(slug);
          void estimateNewIdeas(pool, slug)
            .catch((error: unknown) =>
              logOnce(`estimate:${slug}`, `[${slug}] Schätzung fehlgeschlagen: ${describeError(error)}`),
            )
            .finally(() => estimateActive.delete(slug));
        }
        // Der Auftragsautor arbeitet neben dem Entwickler, solange es andere Aufträge betrifft.
        if (!authorActive.has(slug) && !stopping) {
          authorActive.add(slug);
          void draftRequirements(pool, target.options)
            .then(() => loggedErrors.delete(`author:${slug}`))
            .catch((error: unknown) =>
              logOnce(`author:${slug}`, `[${slug}] Anforderung fehlgeschlagen: ${describeError(error)}`),
            )
            .finally(() => authorActive.delete(slug));
        }
        // KI-Kommentar zum Sprintvorschlag (Auftragsautor, nur Text) – auf Knopfdruck in der Oberfläche.
        if (!commentActive.has(slug) && !stopping) {
          commentActive.add(slug);
          void commentSprintProposal(pool, target.options)
            .catch((error: unknown) =>
              logOnce(`comment:${slug}`, `[${slug}] Sprint-Kommentar fehlgeschlagen: ${describeError(error)}`),
            )
            .finally(() => commentActive.delete(slug));
        }
        // Visionär: angeforderte Läufe („Ideen vorschlagen lassen“) je Projekt nacheinander abarbeiten.
        if (!visionaryActive.has(slug) && !stopping) {
          visionaryActive.add(slug);
          void processVisionaryRun(pool, target.options)
            .then(() => loggedErrors.delete(`visionary:${slug}`))
            .catch((error: unknown) =>
              logOnce(`visionary:${slug}`, `[${slug}] Visionär fehlgeschlagen: ${describeError(error)}`),
            )
            .finally(() => visionaryActive.delete(slug));
        }
        chatActive.add(slug);
        void processChat(pool, target.options)
          .then(() => loggedErrors.delete(`chat:${slug}`))
          .catch((error: unknown) => logOnce(`chat:${slug}`, `[${slug}] Chat fehlgeschlagen: ${describeError(error)}`))
          .finally(() => chatActive.delete(slug));
        // Lange Problemanalysen blockieren so keine neuen Chat-Nachrichten.
        if (analysisActive.has(slug)) continue;
        analysisActive.add(slug);
        void analyzeBlocked(pool, target.options)
          .then((count) => (count ? count : verifyAcceptance(pool, target.options)))
          .then(() => loggedErrors.delete(`analysis:${slug}`))
          .catch((error: unknown) =>
            logOnce(`analysis:${slug}`, `[${slug}] Analyse fehlgeschlagen: ${describeError(error)}`),
          )
          .finally(() => analysisActive.delete(slug));
      }
    }, 1500);
    // Each project runs in its own task; at most "maxConcurrentAgents" tasks run at the same time.
    const active = new Map<string, Promise<void>>();
    const lastStart = new Map<string, number>();
    // Sofortstart: Die Datenbank meldet neue Aufträge (LISTEN devlog_work); ein freier Platz weckt ebenfalls.
    const signal = new WorkSignal();
    const stopListening = listenForWork(pool, () => signal.wake());
    const runTarget = async (target: Target): Promise<void> => {
      const slug = target.options.project;
      try {
        await runOnce(pool, target.options);
        errors.set(slug, null);
      } catch (error) {
        errors.set(slug, error instanceof Error ? error.message : String(error));
        console.error(`[${slug}] Runner-Zyklus fehlgeschlagen:`, errors.get(slug));
      }
    };
    // „Dev Log neu starten“: wartet, bis nichts mehr läuft, baut die Container neu und beendet dann den Worker;
    // launchd startet ihn mit dem neuen Code wieder.
    let restartActive = false;
    const restartTimer = setInterval(() => {
      if (restartActive || stopping) return;
      restartActive = true;
      const busy = (): number =>
        active.size +
        chatActive.size +
        analysisActive.size +
        authorActive.size +
        commentActive.size +
        visionaryActive.size +
        testActive.size +
        setupActive;
      void processRestart(pool, INSTALL_ROOT, busy)
        .then(async (result) => {
          if (result === 'failed') {
            const state = await readRestart(pool).catch(() => null);
            await sendPush(pool, {
              title: '⚠ Dev Log Neustart fehlgeschlagen',
              body: state?.message ?? 'Details unter Assistent → Aktionen → System.',
              url: '#dashboard',
              tag: 'system-restart',
            });
          }
          if (result !== 'restart') return;
          console.info('Container neu gebaut – Worker beendet sich und startet mit dem neuen Code neu.');
          stop();
          // Falls noch etwas den Prozess offen hält: spätestens nach einer Minute beenden, damit launchd neu startet.
          setTimeout(() => process.exit(0), 60_000).unref();
        })
        .catch((error: unknown) => logOnce('restart', `Neustart fehlgeschlagen: ${describeError(error)}`))
        .finally(() => (restartActive = false));
    }, 5_000);
    try {
      while (!stopping) {
        try {
          const targets = await resolveTargets(pool, options);
          known = targets.map((target) => target.options.project);
          chatTargets = targets;
          beat();
          const limit = await readMaxAgents(pool);
          // The project that waited longest goes first, so no project starves when slots are scarce.
          targets.sort((a, b) => (lastStart.get(a.options.project) ?? 0) - (lastStart.get(b.options.project) ?? 0));
          for (const target of targets) {
            const slug = target.options.project;
            if (target.problem) {
              errors.set(slug, target.problem);
              continue;
            }
            if (active.has(slug) || active.size >= limit) {
              continue;
            }
            lastStart.set(slug, Date.now());
            const task = runTarget(target).finally(() => {
              active.delete(slug);
              signal.wake();
            });
            active.set(slug, task);
          }
        } catch (error) {
          console.error('Worker-Zyklus fehlgeschlagen:', error instanceof Error ? error.message : error);
        }
        beat();
        await signal.wait(options.intervalMs, () => stopping);
      }
      await Promise.all(active.values());
      while (
        chatActive.size ||
        analysisActive.size ||
        authorActive.size ||
        estimateActive.size ||
        commentActive.size ||
        visionaryActive.size
      )
        await sleep(200);
    } finally {
      await stopListening();
      clearInterval(heartbeat);
      stopFolderWatch();
      clearInterval(restartTimer);
      clearInterval(chatTimer);
      clearInterval(reviewTimer);
      clearInterval(setupTimer);
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('Runner failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
