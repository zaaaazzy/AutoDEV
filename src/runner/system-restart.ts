import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { type CommandExecutor, redactOutput, runCommand } from '../core/command.js';
import { sendPush } from '../core/push.js';
import { SANDBOX_IMAGE } from '../core/sandbox.js';
import { inWorkerContainer } from '../core/worker-container.js';
import { gitEnvironment } from './project-command.js';

/**
 * „AIdeation neu starten“ (Aktionen im Assistenten): Die Oberfläche fordert den Neustart an, der Worker auf dem Host
 * holt den neuesten Stand per Fast-Forward von origin (pullBranch), baut die Container mit
 * `docker compose up -d --build` neu und beendet sich danach selbst (RESTART_EXIT_CODE). launchd (KeepAlive),
 * systemd (Restart=always) bzw. unter Windows die Schleife in scripts\run-with-env.ps1 starten ihn sofort wieder –
 * mit dem neuen Code und den neuen Agents. Der Stand liegt in app_settings.
 *
 * Worker im Container (Dienst worker, DEV_LOG_WORKER_CONTAINER=1): Dieselben Schritte laufen über den eingebundenen
 * Docker-Socket. Neu gebaut und gestartet werden alle Dienste ausser Worker und Wächter (Compose ersetzte sonst den
 * Container, in dem der Neubau gerade läuft); ihr Image wird nur gebaut. Danach startet die Compose-Restart-Richtlinie
 * den Worker neu, der den neuen Code aus dem eingebundenen AIdeation-Ordner lädt.
 */
export const RESTART_KEY = 'system:restart';
export const RESTART_COMMAND = ['docker', 'compose', 'up', '-d', '--build'];
/** Compose-Dienst des Workers im Container (docker-compose.yml). */
export const WORKER_SERVICE = 'worker';
/**
 * Dienste des Profils worker: Der Worker baut sie beim Neustart nicht selbst neu. Ihre Ordner stehen in
 * docker-compose.override.yml mit Host-Pfaden (unter Windows C:\…), die Compose nur auf dem Host richtig auflöst.
 * Der Wächter lädt den neuen Code ohnehin bei jedem Prüflauf aus dem eingebundenen Ordner.
 */
export const WORKER_SERVICES: readonly string[] = [WORKER_SERVICE, 'worker-volumes', 'watchdog'];
/** Dienste der aktiven Profile (Container-Modus: alle ausser WORKER_SERVICES werden neu gebaut). */
export const SERVICES_COMMAND = ['docker', 'compose', 'config', '--services'];
/** Image des Worker-Dienstes; gilt ab dem nächsten Ersetzen des Containers (start.sh, docker compose up -d). */
export const WORKER_IMAGE_COMMAND = ['docker', 'compose', 'build', WORKER_SERVICE];
/** Image der Agent-Sandbox (src/core/sandbox.ts); baut beim Neustart mit. */
export const AGENT_IMAGE_COMMAND = ['docker', 'build', '-t', SANDBOX_IMAGE, '-f', 'deploy/agent/Dockerfile', '.'];
const AGENT_IMAGE_LOG_CHARS = 1_000;
const BUILD_TIMEOUT_MS = 20 * 60_000;
/** Höchstens so lange auf laufende Aufträge warten; danach werden sie unterbrochen und nach dem Start fortgesetzt. */
export const MAX_WAIT_MS = 15 * 60_000;
const MAX_LOG_CHARS = 4_000;
/**
 * Exit-Code des Workers nach einem erfolgreichen Neubau (75 = EX_TEMPFAIL). launchd und systemd starten ihn bei
 * jedem Code neu; unter Windows startet scripts\run-with-env.ps1 den Worker genau bei diesem Code wieder – die
 * geplante Aufgabe selbst läuft nur bei der Anmeldung an. Im Container greift „restart: unless-stopped“.
 */
export const RESTART_EXIT_CODE = 75;
/**
 * Steht „restarting“ länger, ist der Worker nicht wiedergekommen (z. B. Windows-Aufgabe ohne Neustart-Schleife):
 * Dann darf ein neuer Neustart angefordert werden, statt dauerhaft 409 zu bekommen.
 */
export const RESTARTING_STALE_MS = 10 * 60_000;

/**
 * Umgebung für Compose-Aufrufe (Neubau, Rollback, Abbilder): ohne `DEV_LOG_*` und `COMPOSE_*`. Bei Compose gehen
 * Shell-Variablen der `.env` vor – auch leere. Der Worker hat z. B. `DEV_LOG_SECRET_KEY` aus seiner Env-Datei (ggf.
 * leer oder veraltet) und setzt `DEV_LOG_PROJECT_ROOTS` selbst; ohne Filter bekäme der neue Container diese Werte
 * statt der `.env` und verlöre im schlimmsten Fall den Schlüssel für die verschlüsselten Zugänge.
 */
export function composeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !/^(DEV_LOG|COMPOSE)_/i.test(key)));
}

export type RestartStatus = 'requested' | 'building' | 'restarting' | 'done' | 'failed';

export interface RestartState {
  status: RestartStatus;
  requestedAt: string;
  requestedBy: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  /** Seit wann der Worker sich zum Neustart beendet (Status „restarting“). */
  restartingAt?: string | null;
  /** Kurze Meldung für die Oberfläche (z. B. „Wartet auf 1 laufenden Auftrag“). */
  message?: string | null;
  /** Ende der Ausgabe von docker compose. */
  log?: string | null;
  /** Kommentar aus der Bestätigung (z. B. warum neu gestartet wird). */
  comment?: string | null;
}

export const OPEN_STATUSES: readonly RestartStatus[] = ['requested', 'building', 'restarting'];

/** Darf der Worker neue Arbeit starten? Nicht, solange ein Neustart angefordert ist oder die Container gebaut werden. */
export function acceptsNewWork(state: Pick<RestartState, 'status'> | null): boolean {
  return state?.status !== 'requested' && state?.status !== 'building';
}

type Queryable = Pick<Pool, 'query'>;

export async function readRestart(pool: Queryable): Promise<RestartState | null> {
  const row = (await pool.query<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', [RESTART_KEY]))
    .rows[0];
  if (!row) return null;
  try {
    return JSON.parse(row.value) as RestartState;
  } catch {
    return null;
  }
}

/** Meldet das Ende eines Neustarts (fertig oder fehlgeschlagen), z. B. per Push. */
export type RestartNotifier = (pool: Queryable, state: RestartState) => Promise<void>;

function currentVersion(): string | null {
  try {
    const head = execFileSync('git', ['log', '-1', '--format=%h %s'], {
      encoding: 'utf8',
      timeout: 5_000,
      env: gitEnvironment(),
    }).trim();
    return head ? `Stand: ${head}` : null;
  } catch {
    return null;
  }
}

/** Push an alle Geräte: Ohne diese Meldung sieht man nicht, ob der Neustart durch ist (Container laufen einfach weiter). */
export const notifyRestart: RestartNotifier = async (pool, state) => {
  const done = state.status === 'done';
  await sendPush(pool as Pool, {
    title: done ? '✓ AIdeation neu gestartet' : '⚠ AIdeation-Neustart fehlgeschlagen',
    body: [state.message, done ? currentVersion() : null].filter(Boolean).join('\n'),
    url: '#dashboard',
    tag: 'system-restart',
  }).catch(() => 0);
};

async function writeRestart(
  pool: Queryable,
  state: RestartState,
  notify: RestartNotifier = notifyRestart,
): Promise<RestartState> {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [RESTART_KEY, JSON.stringify(state)],
  );
  if (state.status === 'done' || state.status === 'failed') await notify(pool, state).catch(() => undefined);
  return state;
}

/** „restarting“ seit mehr als RESTARTING_STALE_MS: Der Worker hat sich beendet, ist aber nicht wieder gestartet. */
function restartStale(state: RestartState, now: Date): boolean {
  if (state.status !== 'restarting') return false;
  const since = Date.parse(state.restartingAt ?? state.startedAt ?? state.requestedAt);
  return Number.isFinite(since) && now.getTime() - since > RESTARTING_STALE_MS;
}

/** Neustart anfordern; läuft schon einer, wird dieser zurückgegeben (created = false). */
export async function requestRestart(
  pool: Queryable,
  requestedBy: string | null,
  now = new Date(),
  comment: string | null = null,
): Promise<{ state: RestartState; created: boolean }> {
  const current = await readRestart(pool);
  if (current && OPEN_STATUSES.includes(current.status) && !restartStale(current, now))
    return { state: current, created: false };
  const state = await writeRestart(pool, {
    status: 'requested',
    requestedAt: now.toISOString(),
    requestedBy,
    comment: comment?.trim().slice(0, 2000) || null,
    message: 'Angefordert – der Worker übernimmt gleich.',
  });
  return { state, created: true };
}

/**
 * Beim Start des Workers: Ein Neustart im Status „restarting“ ist damit abgeschlossen. Ein „building“, das den
 * Worker nicht überlebt hat, gilt als fehlgeschlagen.
 */
export async function completeRestart(
  pool: Queryable,
  now = new Date(),
  notify: RestartNotifier = notifyRestart,
): Promise<RestartState | null> {
  const current = await readRestart(pool);
  if (current?.status === 'restarting') {
    return writeRestart(
      pool,
      {
        ...current,
        status: 'done',
        finishedAt: now.toISOString(),
        message: 'Container neu gebaut, Worker mit neuem Code und neuen Agents gestartet.',
      },
      notify,
    );
  }
  if (current?.status === 'building') {
    return writeRestart(
      pool,
      {
        ...current,
        status: 'failed',
        finishedAt: now.toISOString(),
        message: 'Der Worker wurde während des Neubaus beendet. Bitte erneut starten.',
      },
      notify,
    );
  }
  return current;
}

/** Wo die Oberfläche nach dem Neubau antworten muss (Port aus docker-compose.yml, nur lokal). */
export const HEALTH_URL = 'http://127.0.0.1:3100/health';

/** Health-URL für diesen Worker: im Container das Frontend im Compose-Netz (DEV_LOG_HEALTH_URL), sonst HEALTH_URL. */
export function healthUrl(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.DEV_LOG_HEALTH_URL?.trim() || HEALTH_URL;
}

/** Dienstnamen aus `docker compose config --services`, ohne Worker und Wächter; null, wenn keiner lesbar ist. */
export function servicesToRebuild(output: string): string[] | null {
  const services = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(line) && !WORKER_SERVICES.includes(line));
  return services.length ? services : null;
}
const HEALTH_TIMEOUT_MS = 120_000;

export interface RestartOptions {
  /**
   * Nur dieser Branch darf live gehen (Standard: DEV_LOG_RESTART_BRANCH bzw. „main“; „*“ erlaubt jeden Branch).
   * Gebaut wird der Arbeitsordner, wie er ist – ohne Prüfung ginge ein zufällig ausgecheckter Branch oder eine
   * halbfertige Änderung live.
   */
  branch?: string;
  /** Antwortet die Oberfläche? Standard: GET HEALTH_URL. */
  health?: () => Promise<boolean>;
  /** Wie lange nach dem Neubau auf eine Antwort gewartet wird. */
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  /** Meldung bei Ende (fertig/fehlgeschlagen); Standard: Push an alle Geräte. */
  notify?: RestartNotifier;
  /** Liest eine Datei im Installationsordner (null, wenn sie fehlt); Standard: Dateisystem. */
  readText?: (path: string) => Promise<string | null>;
  /** Läuft der Worker selbst als Compose-Dienst? Standard: DEV_LOG_WORKER_CONTAINER=1. */
  container?: boolean;
}

/**
 * Der Worker läuft per tsx direkt aus dem Installationsordner mit dessen node_modules – nicht im Container. Ohne
 * `npm ci` auf dem Host startet er nach einer neuen Laufzeitabhängigkeit nicht (ERR_MODULE_NOT_FOUND, KeepAlive-Schleife).
 */
export const DEPENDENCY_COMMAND = ['npm', 'ci', '--ignore-scripts'];
const DEPENDENCY_TIMEOUT_MS = 10 * 60_000;

async function readTextFile(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null);
}

/**
 * Passt node_modules nicht mehr zu package-lock.json? Verglichen wird mit dem versteckten Lockfile, das npm beim
 * Installieren in node_modules/.package-lock.json schreibt. Fehlt es oder ist es unlesbar, gilt der Stand als veraltet.
 * Optionale Pakete fremder Plattformen (z. B. esbuild für Linux) stehen nur im Lockfile und zählen nicht.
 */
export function dependenciesOutdated(lockfile: string, installed: string | null): boolean {
  type Packages = Record<string, { version?: string; optional?: boolean } | undefined>;
  const packagesOf = (text: string): Packages | null => {
    try {
      const packages = (JSON.parse(text) as { packages?: unknown }).packages;
      return typeof packages === 'object' && packages !== null ? (packages as Packages) : null;
    } catch {
      return null;
    }
  };
  const wanted = packagesOf(lockfile);
  const present = installed === null ? null : packagesOf(installed);
  if (!wanted || !present) return true;
  for (const [path, entry] of Object.entries(wanted)) {
    if (!path) continue;
    const have = present[path];
    if (!have) {
      if (entry?.optional) continue;
      return true;
    }
    if (have.version !== entry?.version) return true;
  }
  return Object.keys(present).some((path) => path && !wanted[path]);
}

async function defaultHealth(): Promise<boolean> {
  try {
    const response = await fetch(healthUrl(), { signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitHealthy(options: RestartOptions): Promise<boolean> {
  const health = options.health ?? defaultHealth;
  const deadline = Date.now() + (options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS);
  for (;;) {
    if (await health()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, options.healthIntervalMs ?? 3_000));
  }
}

/** Darf der Arbeitsordner so live gehen? Liefert den Grund, wenn nicht (falscher Branch, nicht committete Änderungen). */
export async function deployProblem(
  installRoot: string,
  execute: CommandExecutor,
  branch = process.env.DEV_LOG_RESTART_BRANCH?.trim() || 'main',
): Promise<string | null> {
  const git = (...args: string[]) =>
    execute(['git', ...args], installRoot, { timeoutMs: 30_000, env: gitEnvironment() });
  const head = await git('rev-parse', '--abbrev-ref', 'HEAD');
  if (head.exitCode !== 0) return `Git-Stand nicht lesbar: ${head.output.trim().slice(-200)}`;
  const current = head.output.trim();
  if (branch !== '*' && current !== branch) {
    return `Im AIdeation-Ordner ist „${current}“ ausgecheckt, live gehen darf nur „${branch}“. Bitte „git switch ${branch}“ (oder DEV_LOG_RESTART_BRANCH anpassen).`;
  }
  const status = await git('status', '--porcelain', '--untracked-files=no');
  if (status.exitCode !== 0) return `Git-Stand nicht lesbar: ${status.output.trim().slice(-200)}`;
  const changed = status.output
    .trimEnd()
    .split('\n')
    .filter((line) => line.trim());
  if (changed.length) {
    const files = changed
      .slice(0, 5)
      .map((line) => line.slice(3))
      .join(', ');
    return `Nicht committete Änderungen im AIdeation-Ordner (${files}${changed.length > 5 ? ' …' : ''}). Erst committen oder verwerfen.`;
  }
  return null;
}

/**
 * Holt vor dem Bau den neuesten Stand des ausgecheckten Branches von „origin“, nur per Fast-Forward. Läuft erst nach
 * deployProblem, also nur auf einem sauberen Stand des erlaubten Branches – so geht ein auf GitHub gemergter Pull
 * Request mit dem nächsten Neustart live. Scheitert es (offline, kein Remote, lokale Commits, die origin nicht hat),
 * wird der lokale Stand gebaut; die Rückgabe sagt, was passiert ist.
 */
export async function pullBranch(installRoot: string, execute: CommandExecutor): Promise<string> {
  const git = (timeoutMs: number, ...args: string[]) =>
    execute(['git', ...args], installRoot, { timeoutMs, env: gitEnvironment() });
  const remotes = await git(30_000, 'remote');
  if (remotes.exitCode !== 0 || !remotes.output.split('\n').some((line) => line.trim() === 'origin')) {
    return 'Kein Remote „origin“ – gebaut wird der lokale Stand.';
  }
  const branch = (await git(30_000, 'rev-parse', '--abbrev-ref', 'HEAD')).output.trim();
  const before = (await git(30_000, 'rev-parse', 'HEAD')).output.trim();
  const fetched = await git(120_000, 'fetch', '--quiet', 'origin', branch);
  if (fetched.exitCode !== 0) {
    return `GitHub nicht erreichbar (${fetched.output.trim().slice(-160) || `Exit-Code ${fetched.exitCode}`}) – gebaut wird der lokale Stand.`;
  }
  const merged = await git(60_000, 'merge', '--ff-only', 'FETCH_HEAD');
  if (merged.exitCode !== 0) {
    return `Lokaler Stand weicht von origin/${branch} ab, kein Fast-Forward möglich – gebaut wird der lokale Stand.`;
  }
  const after = (await git(30_000, 'rev-parse', 'HEAD')).output.trim();
  return before === after
    ? `Stand von origin/${branch} war schon aktuell.`
    : `Neuester Stand von origin/${branch} geholt (${before.slice(0, 7)} → ${after.slice(0, 7)}).`;
}

/** Abbild des laufenden Dienstes „dev-log“ vor dem Neubau – zum Zurücksetzen, falls der neue Stand nicht startet. */
export interface PreviousImage {
  id: string;
  repository: string;
  tag: string;
}

export function parseComposeImages(output: string): PreviousImage[] {
  const images: PreviousImage[] = [];
  try {
    const parsed = JSON.parse(output.trim()) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of list) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const id = typeof record.ID === 'string' ? record.ID : null;
      const repository = typeof record.Repository === 'string' ? record.Repository : null;
      const tag = typeof record.Tag === 'string' && record.Tag ? record.Tag : 'latest';
      if (id && repository && /^[\w./:-]+$/.test(repository) && /^[\w:.-]+$/.test(id) && /^[\w.-]+$/.test(tag))
        images.push({ id, repository, tag });
    }
  } catch {
    // Ältere Compose-Versionen ohne JSON-Ausgabe: dann ohne Zurücksetzen.
  }
  return images;
}

/** Selbst gebaute Dienste: Backend (API) und Frontend (Oberfläche) – beide werden bei Bedarf zurückgesetzt. */
export const BUILT_SERVICES = ['dev-log', 'frontend'];

/**
 * Arbeitet einen angeforderten Neustart ab. `busy` liefert die Zahl laufender Aufgaben des Workers; solange welche
 * laufen, wird bis MAX_WAIT_MS gewartet. Ergebnis „restart“: Container sind neu gebaut, der Worker soll sich beenden.
 */
export async function processRestart(
  pool: Queryable,
  installRoot: string,
  busy: () => number,
  execute: CommandExecutor = runCommand,
  now: () => Date = () => new Date(),
  options: RestartOptions = {},
): Promise<'idle' | 'waiting' | 'failed' | 'restart'> {
  const current = await readRestart(pool);
  if (current?.status !== 'requested') return 'idle';
  const running = busy();
  const waited = now().getTime() - Date.parse(current.requestedAt);
  if (running > 0 && waited < MAX_WAIT_MS) {
    const message = `Wartet auf ${running} laufende Aufgabe${running === 1 ? '' : 'n'} (höchstens ${MAX_WAIT_MS / 60_000} Minuten).`;
    if (current.message !== message) await writeRestart(pool, { ...current, message });
    return 'waiting';
  }
  const problem = await deployProblem(installRoot, execute, options.branch).catch(
    (error: unknown) => `Git-Stand nicht lesbar: ${error instanceof Error ? error.message : String(error)}`,
  );
  if (problem) {
    await writeRestart(
      pool,
      {
        ...current,
        status: 'failed',
        finishedAt: now().toISOString(),
        message: `Nicht neu gebaut: ${problem} AIdeation läuft unverändert weiter.`,
      },
      options.notify,
    );
    return 'failed';
  }
  const pulled = await pullBranch(installRoot, execute).catch(
    (error: unknown) =>
      `Neuester Stand nicht geholt (${error instanceof Error ? error.message : String(error)}) – gebaut wird der lokale Stand.`,
  );
  // Worker im Container: alle Dienste ausser dem Worker selbst (laut dem eben geholten Stand der Compose-Datei).
  const container = options.container ?? inWorkerContainer();
  let restartCommand = RESTART_COMMAND;
  if (container) {
    const listed = await execute(SERVICES_COMMAND, installRoot, {
      timeoutMs: 30_000,
      env: composeEnvironment(),
    }).catch((error: unknown) => ({ exitCode: 1, durationMs: 0, output: String(error) }));
    const services = listed.exitCode === 0 ? servicesToRebuild(listed.output) : null;
    if (!services) {
      await writeRestart(
        pool,
        {
          ...current,
          status: 'failed',
          finishedAt: now().toISOString(),
          message: `Nicht neu gebaut: ${SERVICES_COMMAND.join(' ')} lieferte keine Dienste (Exit-Code ${listed.exitCode}). AIdeation läuft unverändert weiter.`,
          log: redactOutput(listed.output, process.env).trim().slice(-MAX_LOG_CHARS),
        },
        options.notify,
      );
      return 'failed';
    }
    restartCommand = [...RESTART_COMMAND, ...services];
  }
  const building = await writeRestart(pool, {
    ...current,
    status: 'building',
    startedAt: now().toISOString(),
    message: `${pulled} Baut die Container neu: ${restartCommand.join(' ')}`,
  });
  // Vor dem Neubau: node_modules des Workers auf den Stand des Lockfiles bringen. Scheitert das, geht nichts live
  // und der Worker beendet sich nicht – sonst stürzte er nach dem Neustart in einer Schleife ab.
  const readText = options.readText ?? readTextFile;
  const lockfile = await readText(join(installRoot, 'package-lock.json'));
  if (
    lockfile !== null &&
    dependenciesOutdated(lockfile, await readText(join(installRoot, 'node_modules', '.package-lock.json')))
  ) {
    await writeRestart(pool, {
      ...building,
      message: `Aktualisiert die Abhängigkeiten des Workers: ${DEPENDENCY_COMMAND.join(' ')}`,
    });
    const install = await execute(DEPENDENCY_COMMAND, installRoot, {
      timeoutMs: DEPENDENCY_TIMEOUT_MS,
      env: composeEnvironment(),
    }).catch((error: unknown) => ({
      exitCode: 1,
      durationMs: 0,
      output: error instanceof Error ? error.message : String(error),
    }));
    if (install.exitCode !== 0) {
      await writeRestart(
        pool,
        {
          ...building,
          status: 'failed',
          finishedAt: now().toISOString(),
          message: `${DEPENDENCY_COMMAND.join(' ')} ist fehlgeschlagen (Exit-Code ${install.exitCode}). Container nicht neu gebaut, der Worker läuft weiter. Bitte im AIdeation-Ordner „npm ci“ prüfen.`,
          log: redactOutput(install.output, process.env).trim().slice(-MAX_LOG_CHARS),
        },
        options.notify,
      );
      return 'failed';
    }
  }
  const previous = parseComposeImages(
    (
      await execute(['docker', 'compose', 'images', ...BUILT_SERVICES, '--format', 'json'], installRoot, {
        timeoutMs: 30_000,
        env: composeEnvironment(),
      }).catch(() => ({ exitCode: 1, durationMs: 0, output: '' }))
    ).output,
  );
  const result = await execute(restartCommand, installRoot, {
    timeoutMs: BUILD_TIMEOUT_MS,
    env: composeEnvironment(),
  });
  // Vorne steht, ob der neueste Stand geholt wurde; danach das Ende der Ausgabe von docker compose.
  let log = `${pulled}\n\n${redactOutput(result.output, process.env)
    .trim()
    .slice(-(MAX_LOG_CHARS - pulled.length - 2))}`;
  if (result.exitCode !== 0) {
    await writeRestart(
      pool,
      {
        ...building,
        status: 'failed',
        finishedAt: now().toISOString(),
        message: `${restartCommand.join(' ')} ist fehlgeschlagen (Exit-Code ${result.exitCode}). Der Worker läuft mit dem bisherigen Code weiter.`,
        log,
      },
      options.notify,
    );
    return 'failed';
  }
  // Image der Agent-Sandbox (Modi docker und workbench) mitbauen. Scheitert das, startet AIdeation trotzdem neu:
  // Ein Lauf mit eingeschalteter Sandbox meldet das fehlende bzw. alte Image dann selbst (fail-closed).
  await writeRestart(pool, {
    ...building,
    message: `Baut das Image der Agent-Sandbox: ${AGENT_IMAGE_COMMAND.join(' ')}`,
    log,
  });
  const agentImage = await execute(AGENT_IMAGE_COMMAND, installRoot, {
    timeoutMs: BUILD_TIMEOUT_MS,
    env: composeEnvironment(),
  }).catch((error: unknown) => ({
    exitCode: 1,
    durationMs: 0,
    output: error instanceof Error ? error.message : String(error),
  }));
  if (agentImage.exitCode !== 0) {
    log = `${log}\n\nImage der Agent-Sandbox nicht gebaut (Exit-Code ${agentImage.exitCode}):\n${redactOutput(
      agentImage.output,
      process.env,
    )
      .trim()
      .slice(-AGENT_IMAGE_LOG_CHARS)}`.slice(-MAX_LOG_CHARS);
  }
  // Worker im Container: sein Image (Werkzeuge, kein Code) nur bauen. Scheitert das, läuft der Worker mit dem
  // bisherigen Image weiter – der Code kommt ohnehin aus dem eingebundenen Ordner.
  if (container) {
    await writeRestart(pool, {
      ...building,
      message: `Baut das Image des Workers: ${WORKER_IMAGE_COMMAND.join(' ')}`,
      log,
    });
    const workerImage = await execute(WORKER_IMAGE_COMMAND, installRoot, {
      timeoutMs: BUILD_TIMEOUT_MS,
      env: composeEnvironment(),
    }).catch((error: unknown) => ({
      exitCode: 1,
      durationMs: 0,
      output: error instanceof Error ? error.message : String(error),
    }));
    if (workerImage.exitCode !== 0) {
      log = `${log}\n\nImage des Workers nicht gebaut (Exit-Code ${workerImage.exitCode}):\n${redactOutput(
        workerImage.output,
        process.env,
      )
        .trim()
        .slice(-AGENT_IMAGE_LOG_CHARS)}`.slice(-MAX_LOG_CHARS);
    }
  }
  // Gesundheitsprüfung: Antwortet die Oberfläche nicht, zurück auf das vorherige Abbild; der Worker bleibt auf dem
  // bisherigen Stand und startet nicht neu.
  await writeRestart(pool, { ...building, message: 'Container gebaut – prüft, ob AIdeation antwortet …', log });
  if (!(await waitHealthy(options))) {
    let rolledBack = false;
    if (previous.length) {
      let tagged = true;
      for (const image of previous) {
        const result = await execute(['docker', 'tag', image.id, `${image.repository}:${image.tag}`], installRoot, {
          timeoutMs: 30_000,
        });
        tagged &&= result.exitCode === 0;
      }
      const restarted = tagged
        ? await execute(['docker', 'compose', 'up', '-d', '--no-build', ...BUILT_SERVICES], installRoot, {
            timeoutMs: 5 * 60_000,
            env: composeEnvironment(),
          })
        : null;
      rolledBack = restarted?.exitCode === 0 && (await waitHealthy(options));
    }
    await writeRestart(
      pool,
      {
        ...building,
        status: 'failed',
        finishedAt: now().toISOString(),
        message: rolledBack
          ? 'Der neue Stand antwortete nicht – AIdeation läuft wieder mit dem vorherigen Abbild. Der Worker wurde nicht neu gestartet.'
          : 'Der neue Stand antwortet nicht, Zurücksetzen war nicht möglich. Bitte auf dem Mac „docker compose logs dev-log frontend“ prüfen.',
        log,
      },
      options.notify,
    );
    return 'failed';
  }
  await writeRestart(pool, {
    ...building,
    status: 'restarting',
    restartingAt: now().toISOString(),
    message: 'Container laufen mit dem neuen Code. Der Worker startet neu …',
    log,
  });
  return 'restart';
}
