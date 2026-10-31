/**
 * Dauerbetrieb des Workers (`--watch`): der Arbeitszyklus je Projekt und die Takte für alles, was neben den Aufträgen
 * läuft (Chat, Autor, Visionär, Tests, Git, Review-Container, Wartungs-Jobs, Neustart). Jeder Takt ist eine eigene
 * Funktion; welche Aufgabe gerade läuft, hält `WorkerTasks` fest, damit Neustart und Beenden darauf warten können.
 */
import { isAbsolute } from 'node:path';
import type { Pool } from 'pg';
import { logged } from '../core/log.js';
import { processChat, rejectChat } from '../agent/chat.js';
import { estimateNewIdeas } from '../agent/estimation.js';
import { draftRequirements } from '../agent/requirements.js';
import { scheduleRoutines } from '../agent/routine.js';
import { commentSprintProposal } from '../agent/sprint-comment.js';
import { publishSystemAgents } from '../agent/system-agents.js';
import { analyzeBlocked } from '../agent/troubleshoot.js';
import { processVisionaryRun } from '../agent/visionary.js';
import { beatHeartbeat, readMaxAgents } from '../api/worker.js';
import { runCommand } from '../core/command.js';
import { volumeOf, watchFolders } from '../core/folder-guard.js';
import { treeLockName } from '../core/project-lock.js';
import { isDraining, setDraining } from '../core/shutdown.js';
import { processSetupJob } from '../setup/setup-jobs.js';
import { syncFavicon } from './favicon.js';
import { syncGitGraph } from './git-graph.js';
import { processGitFix, syncGitState } from './git-state-sync.js';
import { reconcileWorkingTree } from './git-sync/reconcile.js';
import { syncGitHub } from './github-sync.js';
import { ProductionMonitor } from './production-monitor.js';
import { ReviewSlots } from './review-slots.js';
import { processRollback } from './rollback.js';
import { closeOrphanedRuns, type RunnerOptions } from './runner.js';
import { runDueJobs } from './scheduler.js';
import { syncSprintCommits } from './sprint-commits.js';
import { acceptsNewWork, processRestart, readRestart, RESTART_EXIT_CODE } from './system-restart.js';
import { sandboxStatus } from './test-sandbox.js';
import { processTestRequest } from './test-request.js';
import { verifyAcceptance } from './verify-acceptance.js';
import { listenForWork, WorkSignal } from './work-signal.js';
import { describeError, forgetLogged, logOnce } from './worker-log.js';
import {
  folderInUseBy,
  INSTALL_ROOT,
  notifyFolders,
  resolveTargets,
  runProjectOnce,
  servedTargets,
  type Target,
} from './worker-targets.js';

/** Einrichtungsaufgaben (Ordner, Git, GitHub, Vorlagen, Agent-Tests) laufen parallel, damit der Assistent flott wirkt. */
const SETUP_PARALLEL = 4;
const HEARTBEAT_MS = 15_000;
const ASSISTANT_MS = 1_500;
const SETUP_MS = 500;
const REVIEW_MS = 5_000;
const RESTART_MS = 5_000;
const ROUTINE_MS = 60_000;
const GIT_SYNC_MS = 60_000;
const FAVICON_MS = 5 * 60_000;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Je Projekt höchstens eine laufende Aufgabe dieser Art; ein zweiter Start im selben Takt tut nichts. Fehler erscheinen
 * einmal je Projekt im Log, bis sie sich ändern oder die Aufgabe wieder gelingt.
 */
export class ProjectTasks {
  private readonly active = new Set<string>();

  /** @param key Schlüssel der Fehlermeldung, @param label Text im Log („<label> fehlgeschlagen“). */
  constructor(
    private readonly key: string,
    private readonly label: string,
  ) {}

  get size(): number {
    return this.active.size;
  }

  has(slug: string): boolean {
    return this.active.has(slug);
  }

  start(slug: string, task: () => Promise<unknown>): void {
    if (this.active.has(slug)) return;
    this.active.add(slug);
    void task()
      .then(() => forgetLogged(`${this.key}:${slug}`))
      .catch((error: unknown) =>
        logOnce(`${this.key}:${slug}`, `[${slug}] ${this.label} fehlgeschlagen: ${describeError(error)}`),
      )
      .finally(() => this.active.delete(slug));
  }
}

/** Projektübergreifende Aufgabe mit höchstens `limit` gleichzeitigen Durchgängen (meist einem). */
export class SharedTask {
  private running = 0;

  constructor(
    private readonly key: string,
    private readonly label: string,
    private readonly limit = 1,
  ) {}

  get size(): number {
    return this.running;
  }

  get busy(): boolean {
    return this.running >= this.limit;
  }

  start(task: () => Promise<unknown>): void {
    if (this.busy) return;
    this.running += 1;
    void task()
      .then(() => forgetLogged(this.key))
      .catch((error: unknown) => logOnce(this.key, `${this.label} fehlgeschlagen: ${describeError(error)}`))
      .finally(() => {
        this.running -= 1;
      });
  }
}

/** Alles, was der Worker gerade im Hintergrund tut – an einer Stelle, damit Neustart und Beenden nichts übersehen. */
export class WorkerTasks {
  /** Laufende Arbeitszyklen (Aufträge) je Projekt. */
  readonly agents = new Map<string, Promise<void>>();
  readonly chat = new ProjectTasks('chat', 'Chat');
  readonly analysis = new ProjectTasks('analysis', 'Analyse');
  readonly author = new ProjectTasks('author', 'Anforderung');
  readonly estimate = new ProjectTasks('estimate', 'Schätzung');
  readonly comment = new ProjectTasks('comment', 'Sprint-Kommentar');
  readonly visionary = new ProjectTasks('visionary', 'Visionär');
  readonly tests = new ProjectTasks('test', 'Kompletter Test');
  readonly gitFix = new ProjectTasks('gitfix', 'Git-Lösung');
  readonly rollback = new ProjectTasks('rollback', 'Rollback');
  readonly github = new ProjectTasks('github', 'GitHub-Brücke');
  readonly setup = new SharedTask('setup', 'Einrichtungsaufgabe', SETUP_PARALLEL);
  readonly review = new SharedTask('review', 'Review-Container');
  readonly routines = new SharedTask('routines', 'Routinen-Planer');
  readonly scheduler = new SharedTask('scheduler', 'Wartungs-Jobs');
  readonly orphans = new SharedTask('orphans', 'Aufräumen verwaister Läufe');
  readonly restart = new SharedTask('restart', 'Neustart');

  /** Arbeit, die ein angeforderter Neustart abwartet: Der Neubau beginnt erst bei 0. */
  busy(): number {
    return (
      this.agents.size +
      this.chat.size +
      this.analysis.size +
      this.author.size +
      this.estimate.size +
      this.comment.size +
      this.visionary.size +
      this.tests.size +
      this.gitFix.size +
      this.setup.size +
      this.scheduler.size
    );
  }

  /** Beim Beenden: Hintergrundaufgaben, die vor dem Schliessen des Pools zu Ende laufen sollen. */
  draining(): boolean {
    return (
      this.chat.size +
        this.analysis.size +
        this.author.size +
        this.estimate.size +
        this.comment.size +
        this.visionary.size +
        this.routines.size +
        this.scheduler.size >
      0
    );
  }
}

/** Zustand des laufenden Workers, den alle Takte teilen. */
interface Worker {
  pool: Pool;
  options: RunnerOptions;
  intervalSeconds: number;
  /** SIGTERM/SIGINT oder Neustart: keine neue Arbeit mehr, Laufendes wird fertig. */
  stopping: () => boolean;
  /** Leitet das Beenden ein (wie SIGTERM). */
  stop: () => void;
  /** Projekte aus dem letzten Arbeitszyklus; die Takte lesen immer den aktuellen Stand. */
  targets: Target[];
  /** Noch kein Zyklus gelaufen: Das erste Lebenszeichen je Projekt gilt als Start. */
  startup: boolean;
  /** Letzter Fehler je Projekt (null = zuletzt fehlerfrei) fürs Badge in der Oberfläche. */
  errors: Map<string, string | null>;
  tasks: WorkerTasks;
}

/** Lebenszeichen je Projekt mit Fehler- oder Sandbox-Zustand fürs Badge; der erste Takt gilt als Start. */
function beat(worker: Worker): void {
  const { pool, intervalSeconds, errors } = worker;
  const first = worker.startup;
  for (const target of worker.targets) {
    const slug = target.options.project;
    // Sandbox gesperrt (Docker oder Image fehlt) oder ausdrücklich aus (Notfallmodus): auch das zeigt das Badge.
    void sandboxStatus(pool, slug)
      .then((sandbox) => beatHeartbeat(pool, slug, intervalSeconds, errors.get(slug) ?? sandbox, first))
      .catch(logged('worker-loop'));
  }
  if (worker.targets.length) worker.startup = false;
}

/**
 * Läufe „läuft“ ohne Auftrag dieses Workers dahinter (Abschluss scheiterte an der Datenbank) aufräumen – auch
 * abgebrochene, auf deren Abbruch kein Schritt mehr wartet. Sonst hingen sie bis zum nächsten Neustart.
 */
function closeOrphans(worker: Worker): void {
  const known = worker.targets.map((target) => target.options.project);
  if (worker.stopping() || !known.length) return;
  worker.tasks.orphans.start(async () => {
    const count = await closeOrphanedRuns(worker.pool, known);
    if (count) console.info(`${count} verwaiste Läufe beendet (kein laufender Auftrag dahinter).`);
  });
}

/** Git-Verlauf fürs Dashboard, Git-Zustand, Sprint-Stände und die GitHub-Brücke je Projekt. */
function syncGit(worker: Worker): void {
  const { pool, tasks } = worker;
  for (const target of servedTargets(worker.targets)) {
    const slug = target.options.project;
    void syncGitGraph(pool, slug, target.options.cwd).catch(logged('worker-loop'));
    void syncGitState(pool, slug, target.repository, target.options.cwd).catch(logged('worker-loop'));
    void syncSprintCommits(pool, slug, target.options.cwd).catch(logged('worker-loop'));
    // GitHub-Brücke: Issue-Import, Rückmeldung und Sprints im Review (Intervalle begrenzt das Modul selbst).
    if (!worker.stopping()) tasks.github.start(slug, () => syncGitHub(pool, slug, target.options.cwd));
  }
}

/**
 * Alle 15 s: Lebenszeichen, verwaiste Läufe, Git-Lösungen, Rollbacks, System-Agents, Produktions-Rückkanal
 * (Health-URL alle 2 Minuten, Compose-Logs alle 15 Minuten), jede Minute Git-Abgleich, alle 5 Minuten Favicons.
 */
function startHeartbeat(worker: Worker): () => void {
  const { pool, tasks } = worker;
  const production = new ProductionMonitor(pool);
  let gitCheck = 0;
  let faviconCheck = 0;
  const timer = setInterval(() => {
    beat(worker);
    closeOrphans(worker);
    for (const target of servedTargets(worker.targets)) {
      const slug = target.options.project;
      if (worker.stopping()) continue;
      // Angeforderte Git-Lösungen (Zwischenstand sichern, zurück auf main, main abgleichen) zeitnah ausführen – nicht
      // während eines angeforderten Neustarts (Drain): ein abgebrochener Commit hinterliesse index.lock.
      if (!isDraining()) {
        tasks.gitFix.start(slug, () => processGitFix(pool, slug, target.repository, target.options.cwd));
      }
      // Bestätigte Rollbacks (Bug-Detail „Betrieb“) über den normalen Deploy-Pfad ausrollen.
      tasks.rollback.start(slug, () => processRollback(pool, slug, target.repository, target.options.cwd));
    }
    void publishSystemAgents(pool).catch(logged('worker-loop'));
    if (!worker.stopping()) {
      production.tick(
        servedTargets(worker.targets).map((target) => ({ slug: target.options.project, cwd: target.options.cwd })),
      );
    }
    if (Date.now() - gitCheck > GIT_SYNC_MS) {
      gitCheck = Date.now();
      syncGit(worker);
    }
    if (Date.now() - faviconCheck > FAVICON_MS) {
      faviconCheck = Date.now();
      for (const target of servedTargets(worker.targets)) {
        void syncFavicon(pool, target.options.project, target.options.cwd).catch(logged('worker-loop'));
      }
    }
  }, HEARTBEAT_MS);
  return () => clearInterval(timer);
}

/**
 * Projektordner und AIdeation-Ordner überwachen: Ausfälle (z. B. externes Laufwerk) melden und für Agent-Läufe merken,
 * damit ein Abbruch in dieser Zeit als Unterbrechung gilt statt als Fehler im Auftrag.
 */
function startFolderWatch(worker: Worker): () => void {
  const volumes = (paths: string[]): string[] => [...new Set(paths.map((path) => volumeOf(path) ?? path))];
  return watchFolders(
    () => [
      INSTALL_ROOT,
      ...worker.targets.flatMap((target) => [target.repository, target.options.cwd]).filter((path) => isAbsolute(path)),
    ],
    ({ lost, back }) => {
      for (const volume of volumes(lost)) {
        console.error(`[Ordner] nicht erreichbar: ${volume} – Agents pausieren.`);
        void notifyFolders(worker.pool, worker.targets, volume, false);
      }
      for (const volume of volumes(back)) {
        console.info(`[Ordner] wieder erreichbar: ${volume}`);
        void notifyFolders(worker.pool, worker.targets, volume, true);
      }
    },
  );
}

/** Einrichtungsassistent: Host-Aufgaben schnell und parallel abarbeiten. */
function startSetupLoop(worker: Worker): () => void {
  const timer = setInterval(() => {
    if (worker.stopping() || isDraining()) return;
    worker.tasks.setup.start(() => processSetupJob(worker.pool));
  }, SETUP_MS);
  return () => clearInterval(timer);
}

/** Review-Container (projektübergreifend): angeforderte Stände starten, Freigaben zuweisen, Zustand prüfen. */
function startReviewLoop(worker: Worker): () => void {
  const slots = new ReviewSlots(worker.pool, INSTALL_ROOT, runCommand, undefined, {
    reviewUrl: process.env.DEV_LOG_REVIEW_DATABASE_URL?.trim() || null,
    mainUrl: process.env.DEV_LOG_DATABASE_URL?.trim() || null,
  });
  const timer = setInterval(() => {
    if (worker.stopping() || isDraining()) return;
    worker.tasks.review.start(() => slots.sync());
  }, REVIEW_MS);
  return () => clearInterval(timer);
}

/**
 * Planer für zeitgesteuerte Routinen: jede Minute fällige Agent-Aufgaben als Chat-Nachricht einreihen (der Chat führt
 * sie dann aus). Gesperrte Projekte (laufender Auftrag) bleiben fällig, bis die Sperre frei ist.
 */
function startRoutineLoop(worker: Worker): () => void {
  const timer = setInterval(() => {
    if (worker.stopping() || isDraining()) return;
    const projects = servedTargets(worker.targets).map((target) => target.options.project);
    if (!projects.length) return;
    worker.tasks.routines.start(async () => {
      const result = await scheduleRoutines(worker.pool, projects);
      if (result.queued.length) console.info(`Routinen eingereiht: ${result.queued.length}`);
    });
  }, ROUTINE_MS);
  return () => clearInterval(timer);
}

/**
 * Anfragen eines Projekts, die neben den Aufträgen laufen: kompletter Test, Schätzung, Auftragsautor, Sprint-Kommentar,
 * Visionär, Chat und Problemanalyse. Jede Art höchstens einmal gleichzeitig je Projekt.
 */
function serveAssistant(worker: Worker, target: Target): void {
  const { pool, tasks } = worker;
  const slug = target.options.project;
  if (worker.stopping()) return;
  // Kompletter Test auf Knopfdruck (Aktionen-Menü, Testläufe): unabhängig vom Chat, der sonst alles Weitere blockiert.
  if (!target.problem) tasks.tests.start(slug, () => processTestRequest(pool, target.options));
  if (tasks.chat.has(slug)) return;
  if (target.problem) {
    // Laufwerk nur kurz weg: Anfragen bleiben wartend und laufen, sobald der Ordner wieder da ist.
    if (!target.transient) void rejectChat(pool, slug, target.problem).catch(logged('worker-loop'));
    return;
  }
  tasks.estimate.start(slug, () => estimateNewIdeas(pool, slug));
  // Der Auftragsautor arbeitet neben dem Entwickler, solange es andere Aufträge betrifft – nur lesend
  // (runAuthorAgent ist standardmässig read-only), er hält den Arbeitsordner deshalb nicht.
  tasks.author.start(slug, () => draftRequirements(pool, target.options));
  // KI-Kommentar zum Sprintvorschlag (Auftragsautor, nur Text) – auf Knopfdruck in der Oberfläche.
  tasks.comment.start(slug, () => commentSprintProposal(pool, target.options));
  // Visionär: angeforderte Läufe („Ideen vorschlagen lassen“) je Projekt nacheinander abarbeiten.
  tasks.visionary.start(slug, () => processVisionaryRun(pool, target.options));
  tasks.chat.start(slug, () => processChat(pool, target.options));
  // Lange Problemanalysen blockieren so keine neuen Chat-Nachrichten.
  tasks.analysis.start(slug, async () => {
    const analyzed = await analyzeBlocked(pool, target.options);
    if (!analyzed) await verifyAcceptance(pool, target.options);
  });
}

/** Chat-Antworten und die anderen Anfragen laufen unabhängig von Aufträgen, damit der Assistent sofort reagiert. */
function startAssistantLoop(worker: Worker): () => void {
  const timer = setInterval(() => {
    // Neustart steht an: Chat, Tests, Analysen und Visionär warten, bis der Worker neu gestartet ist.
    if (isDraining()) return;
    for (const target of worker.targets) serveAssistant(worker, target);
  }, ASSISTANT_MS);
  return () => clearInterval(timer);
}

/**
 * „AIdeation neu starten“: Erst den Stand lesen – ist ein Neustart angefordert oder im Bau, startet ab jetzt nichts
 * Neues mehr (Drain). So wird busy() wirklich 0, und der Neubau beendet keine Arbeit mitten im Schritt. Danach baut
 * processRestart die Container neu und beendet den Worker; launchd/systemd, der Windows-Wrapper bzw. im Container die
 * Compose-Restart-Richtlinie starten ihn neu.
 */
async function checkRestart(worker: Worker): Promise<void> {
  const state = await readRestart(worker.pool);
  const draining = !acceptsNewWork(state);
  if (draining !== isDraining()) {
    console.info(
      draining
        ? 'Neustart angefordert – keine neue Arbeit mehr, Laufendes wird fertig.'
        : 'Neustart abgeschlossen oder verworfen – Arbeit läuft wieder.',
    );
  }
  setDraining(draining);
  const result = await processRestart(worker.pool, INSTALL_ROOT, () => worker.tasks.busy());
  // Ein gescheiterter Neustart meldet sich selbst per Push (writeRestart → notifyRestart).
  if (result !== 'restart') return;
  console.info('Container neu gebaut – Worker beendet sich und startet mit dem neuen Code neu.');
  // RESTART_EXIT_CODE: Daran erkennt der Windows-Wrapper (run-with-env.ps1), dass er neu starten soll.
  process.exitCode = RESTART_EXIT_CODE;
  worker.stop();
  // Falls noch etwas den Prozess offen hält: spätestens nach einer Minute beenden, damit der Dienst neu startet.
  setTimeout(() => process.exit(RESTART_EXIT_CODE), 60_000).unref();
}

function startRestartWatch(worker: Worker): () => void {
  const timer = setInterval(() => {
    if (worker.stopping()) return;
    worker.tasks.restart.start(() => checkRestart(worker));
  }, RESTART_MS);
  return () => clearInterval(timer);
}

/**
 * Wartungs-Jobs (scheduled_jobs): im Arbeitszyklus angestossen, aber im Hintergrund – jeder Job hat sein Zeitlimit,
 * der Zyklus wartet nie darauf. Projektübergreifend, deshalb ausserhalb von runWorkflow (das je Projekt läuft).
 */
function runScheduledJobs(worker: Worker): void {
  if (worker.stopping() || isDraining()) return;
  worker.tasks.scheduler.start(async () => {
    const runs = await runDueJobs(worker.pool, { installRoot: INSTALL_ROOT }, worker.stopping);
    for (const run of runs) console.info(`[Job ${run.key}] ${run.status}: ${run.message}`);
  });
}

/** Ein Arbeitszyklus für ein Projekt; das Ergebnis landet im Badge (errors). */
async function runProject(worker: Worker, target: Target): Promise<void> {
  const slug = target.options.project;
  try {
    await runProjectOnce(worker.pool, target.options);
    worker.errors.set(slug, null);
  } catch (error) {
    worker.errors.set(slug, error instanceof Error ? error.message : String(error));
    console.error(`[${slug}] Runner-Zyklus fehlgeschlagen:`, worker.errors.get(slug));
  }
}

/** Belegung der Plätze für Aufträge: Ordner (realpath-Schlüssel) der laufenden Projekte und letzter Start je Projekt. */
interface Slots {
  /** Ein Ordner, ein Auftrag – auch projektübergreifend (gleiches Repository, Symlink). */
  folders: Map<string, string>;
  lastStart: Map<string, number>;
}

/** Startet für jedes wartende Projekt einen Arbeitszyklus, solange Plätze frei sind; das längst wartende zuerst. */
function startDueProjects(worker: Worker, limit: number, slots: Slots, signal: WorkSignal): void {
  const { tasks, errors } = worker;
  // Das Projekt, das am längsten wartet, kommt zuerst, damit bei knappen Plätzen keines verhungert.
  const targets = [...worker.targets].sort(
    (a, b) => (slots.lastStart.get(a.options.project) ?? 0) - (slots.lastStart.get(b.options.project) ?? 0),
  );
  for (const target of targets) {
    const slug = target.options.project;
    if (target.problem) {
      errors.set(slug, target.problem);
      continue;
    }
    if (tasks.agents.has(slug) || tasks.agents.size >= limit || isDraining()) continue;
    const owner = folderInUseBy(target.options.cwd, slots.folders);
    if (owner) {
      logOnce(`folder:${slug}`, `[${slug}] wartet auf Arbeitsordner – Projekt „${owner}“ arbeitet im selben Ordner.`);
      continue;
    }
    forgetLogged(`folder:${slug}`);
    slots.lastStart.set(slug, Date.now());
    slots.folders.set(slug, treeLockName(target.options.cwd));
    const task = runProject(worker, target).finally(() => {
      tasks.agents.delete(slug);
      slots.folders.delete(slug);
      // Ein freier Platz weckt den Zyklus, damit das nächste Projekt sofort startet.
      signal.wake();
    });
    tasks.agents.set(slug, task);
  }
}

/** Einmal nach dem Start, bevor Arbeit beginnt: Reste eines hart beendeten Laufs im Arbeitsordner aufräumen. */
async function reconcileWorkingTrees(worker: Worker): Promise<void> {
  for (const target of servedTargets(worker.targets)) {
    await reconcileWorkingTree(worker.pool, target.options.project, target.repository, target.options.cwd).catch(
      logged('worker-loop'),
    );
  }
}

/**
 * Der Arbeitszyklus: Projekte auflösen, Lebenszeichen, Aufträge starten, Wartungs-Jobs anstossen, dann bis zum
 * nächsten Takt warten. Die Datenbank meldet neue Aufträge (LISTEN devlog_work), ein freier Platz weckt ebenfalls.
 */
async function runWorkLoop(worker: Worker, signal: WorkSignal): Promise<void> {
  const slots: Slots = { folders: new Map(), lastStart: new Map() };
  let reconciled = false;
  while (!worker.stopping()) {
    try {
      worker.targets = await resolveTargets(worker.pool, worker.options);
      if (!reconciled) {
        reconciled = true;
        await reconcileWorkingTrees(worker);
      }
      beat(worker);
      const limit = await readMaxAgents(worker.pool);
      startDueProjects(worker, limit, slots, signal);
    } catch (error) {
      // describeError: pg meldet eine ausgefallene Datenbank als AggregateError ohne Text (nur der Code sagt etwas).
      console.error('Worker-Zyklus fehlgeschlagen:', describeError(error));
    }
    runScheduledJobs(worker);
    beat(worker);
    await signal.wait(worker.options.intervalMs, worker.stopping);
  }
  await Promise.all(worker.tasks.agents.values());
}

/**
 * Der Dauer-Worker: läuft, bis `control.stopping()` wahr wird, und wartet dann, bis laufende Aufträge und
 * Hintergrundaufgaben zu Ende sind. Vorbereitung (Sperre, Aufräumen des Vorgängers, Prozessregister) macht der Aufrufer.
 */
export async function runWorker(
  pool: Pool,
  options: RunnerOptions,
  control: { stopping: () => boolean; stop: () => void },
): Promise<void> {
  const intervalSeconds = Math.round(options.intervalMs / 1000);
  console.info(
    `Worker gestartet (${options.all ? 'alle Projekte' : options.project}, Intervall ${intervalSeconds} s).`,
  );
  const worker: Worker = {
    pool,
    options,
    intervalSeconds,
    stopping: control.stopping,
    stop: control.stop,
    targets: [],
    startup: true,
    errors: new Map(),
    tasks: new WorkerTasks(),
  };
  void publishSystemAgents(pool).catch(logged('worker-loop'));
  const signal = new WorkSignal();
  const stopListening = listenForWork(pool, () => signal.wake());
  const stops = [
    startHeartbeat(worker),
    startFolderWatch(worker),
    startSetupLoop(worker),
    startReviewLoop(worker),
    startRoutineLoop(worker),
    startAssistantLoop(worker),
    startRestartWatch(worker),
  ];
  try {
    await runWorkLoop(worker, signal);
    while (worker.tasks.draining()) await sleep(200);
  } finally {
    await stopListening();
    for (const stop of stops) stop();
  }
}
