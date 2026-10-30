import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CommandExecutor, type CommandResult, redactOutput, runCommand } from './command.js';
import {
  blocked,
  containerCommand,
  containerDirectory,
  credentialProblem,
  dependencyCommand,
  dependencyStamp,
  dockerClientEnvironment,
  EGRESS_CONTAINER,
  EGRESS_URL,
  ensureAgentNetwork,
  hostMount,
  INSTALL_TIMEOUT_MS,
  KILL_TIMEOUT_MS,
  modulesVolume,
  noteProblem,
  prepareModulesVolume,
  SANDBOX_CREDENTIALS,
  SANDBOX_HOME,
  SANDBOX_IMAGE,
  SANDBOX_NETWORK,
  SANDBOX_NO_PROXY,
  SANDBOX_OLLAMA_URL,
  SANDBOX_WORKDIR,
  type SandboxOptions,
  sandboxFailureNote,
  sandboxProblem,
  sandboxUser,
} from './sandbox.js';
import { defined } from './defined.js';

/**
 * Arbeitscontainer je Projekt (Schalter DEV_LOG_AGENT_SANDBOX bzw. projects.agent_sandbox = „workbench“, Standard):
 * ein dauerhafter Compose-Stapel statt eines Wegwerf-Containers je Lauf. Darin dürfen Agents und Projekttests alles,
 * was ein Entwickler-Rechner kann – auch Docker –, ohne den Host zu berühren:
 *
 * - workbench: Image aideation-agent, der Worktree als /workspace, node_modules als Volume des Projekts, ohne
 *   Capabilities, im internen Agent-Netzwerk (hinaus nur über den Egress-Proxy).
 * - docker: eigener Docker-Dienst (docker:dind, privilegiert, aber nur in seinem eigenen Container) im
 *   Netzwerk-Namensraum der workbench, also unter 127.0.0.1:2375. Images, Container und Volumes der Agents liegen in
 *   seinem Volume, nie im Docker des Hosts. Veröffentlichte Ports sind in der workbench unter localhost erreichbar.
 * - Dienste aus .aideation/workbench.json des Projekts (z. B. Postgres für die Tests), ebenfalls unter localhost.
 *
 * Der Worker steuert alles von aussen (docker compose, docker exec). Git-Push, Merge und Live schalten bleiben beim
 * Worker auf dem Host: GitHub-Schlüssel und der Docker-Socket des Hosts kommen nie in den Stapel.
 */

export const WORKBENCH_LABEL = 'aideation.workbench';
const WORKBENCH_HASH_LABEL = 'aideation.workbench.hash';
/** Docker-Dienst im Stapel; Version wie das übrige Docker-Setup. */
export const WORKBENCH_DOCKER_IMAGE = 'docker:29-dind';
/** Docker im Stapel, aus Sicht der workbench (gemeinsamer Netzwerk-Namensraum). */
export const WORKBENCH_DOCKER_HOST = 'tcp://127.0.0.1:2375';
/** Datei im Projekt (Stand des Live-Ordners, nicht des Agent-Worktrees) mit zusätzlichen Diensten. */
export const WORKBENCH_FILE = '.aideation/workbench.json';
const COMPOSE_TIMEOUT_MS = 10 * 60_000;
const CHECK_TIMEOUT_MS = 20_000;

/** Zusätzlicher Dienst eines Projekts; nur diese Felder, alles andere setzt AIdeation selbst. */
export interface WorkbenchService {
  image: string;
  environment?: Record<string, string>;
  command?: string[];
  tmpfs?: string[];
}

/** Inhalt von .aideation/workbench.json. */
export interface WorkbenchExtras {
  services: Record<string, WorkbenchService>;
  /** Umgebung der workbench (z. B. DEV_LOG_DATABASE_URL auf den Postgres-Dienst). */
  environment: Record<string, string>;
}

const NAME = /^[a-z][a-z0-9-]{0,30}$/;
const IMAGE = /^[a-z0-9][a-z0-9._/-]*(?::[\w.-]+)?(?:@sha256:[a-f0-9]{64})?$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(['workbench', 'docker']);

const stringRecord = (value: unknown, label: string): Record<string, string> => {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: Objekt erwartet.`);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (!ENV_KEY.test(key)) throw new Error(`${label}: ungültiger Name „${key}“.`);
      if (typeof entry !== 'string' && typeof entry !== 'number') throw new Error(`${label}.${key}: Text erwartet.`);
      return [key, String(entry)];
    }),
  );
};
const stringList = (value: unknown, label: string): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    throw new Error(`${label}: Liste von Texten erwartet.`);
  return value as string[];
};

/**
 * Liest .aideation/workbench.json. Erlaubt sind je Dienst nur Image, Umgebung, Befehl und tmpfs: keine Ports, Mounts,
 * Rechte oder Netzwerke – diese setzt AIdeation (gemeinsamer Namensraum mit der workbench, sonst nichts).
 */
export function parseWorkbenchExtras(text: string): WorkbenchExtras {
  const raw = JSON.parse(text) as { services?: unknown; environment?: unknown };
  if (!raw || typeof raw !== 'object') throw new Error('workbench.json: Objekt erwartet.');
  const services: Record<string, WorkbenchService> = {};
  const listed = raw.services ?? {};
  if (typeof listed !== 'object' || Array.isArray(listed)) throw new Error('services: Objekt erwartet.');
  for (const [name, value] of Object.entries(listed as Record<string, unknown>)) {
    if (!NAME.test(name) || RESERVED.has(name)) throw new Error(`services: Dienstname „${name}“ ist nicht erlaubt.`);
    const service = value as Record<string, unknown>;
    const unknown = Object.keys(service ?? {}).filter(
      (key) => !['image', 'environment', 'command', 'tmpfs'].includes(key),
    );
    if (unknown.length) throw new Error(`services.${name}: nicht erlaubt: ${unknown.join(', ')}.`);
    if (typeof service.image !== 'string' || !IMAGE.test(service.image))
      throw new Error(`services.${name}.image: Image-Name erwartet.`);
    const tmpfs = stringList(service.tmpfs, `services.${name}.tmpfs`);
    if (tmpfs?.some((path) => !/^\/[\w./-]+$/.test(path) || path.includes('..')))
      throw new Error(`services.${name}.tmpfs: nur absolute Pfade im Container.`);
    services[name] = {
      image: service.image,
      environment: stringRecord(service.environment, `services.${name}.environment`),
      command: stringList(service.command, `services.${name}.command`),
      tmpfs,
    };
  }
  return { services, environment: stringRecord(raw.environment, 'environment') };
}

/** Zusätzliche Dienste aus dem Live-Ordner des Projekts (geprüfter Stand); fehlt die Datei, keine. */
export function readWorkbenchExtras(repository: string | null | undefined): WorkbenchExtras {
  const file = repository ? join(repository, WORKBENCH_FILE) : null;
  if (!file || !existsSync(file)) return { services: {}, environment: {} };
  return parseWorkbenchExtras(readFileSync(file, 'utf8'));
}

/**
 * Haupt-Checkout eines Worktrees (der Live-Ordner): .git ist dort ein Ordner, in einem verknüpften Worktree eine Datei
 * „gitdir: <haupt>/.git/worktrees/<name>“. Von dort kommt workbench.json – der geprüfte Stand, nicht der des Agents.
 */
export function mainCheckout(worktree: string): string {
  const marker = join(worktree, '.git');
  try {
    const text = readFileSync(marker, 'utf8');
    const match = /^gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/][^\\/]+\s*$/m.exec(text);
    return match ? defined(match[1]) : worktree;
  } catch {
    return worktree;
  }
}

const slugOf = (project: string): string =>
  project
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'projekt';

/**
 * Compose-Projekt je Projekt, z. B. „agents_mainty“ (in Docker Desktop eine Gruppe je Anwendung). Ein Projekt hat einen
 * Arbeitsordner; käme ein anderer dazu, ändert sich der Fingerabdruck und der Stapel wird neu erstellt.
 */
export function workbenchName(project: string): string {
  return `agents_${slugOf(project)}`;
}

/** Containername eines Dienstes im Stapel, z. B. „agents_mainty_workbench“, „agents_mainty_docker“. */
export function workbenchContainer(project: string, service = 'workbench'): string {
  return `${workbenchName(project)}_${service}`;
}

export interface WorkbenchOptions extends Pick<
  SandboxOptions,
  'project' | 'platform' | 'uid' | 'gid' | 'cpus' | 'memory' | 'image'
> {
  extras?: WorkbenchExtras;
  /** ID des Images: Nach einem neuen Build (gleicher Name) wird der Stapel so neu erstellt. */
  imageId?: string;
}

/**
 * Startbefehl der workbench: Proxy-Eintrag für Docker (Builds und Container im inneren Docker erreichen npm & Co. nur
 * über den Egress-Proxy – per IP, denn dort gibt es kein DNS des Agent-Netzwerks), dann warten.
 */
const WORKBENCH_START = [
  'sh',
  '-c',
  [
    'mkdir -p "$HOME/.docker"',
    `ip=$(getent hosts ${EGRESS_CONTAINER} | cut -d' ' -f1)`,
    'if [ -n "$ip" ]; then printf \'{"proxies":{"default":{"httpProxy":"http://%s:3128","httpsProxy":"http://%s:3128","noProxy":"localhost,127.0.0.1"}}}\' "$ip" "$ip" > "$HOME/.docker/config.json"; fi',
    'exec sleep infinity',
  ].join('; '),
];

/** Compose ersetzt $VAR selbst (mit Werten des Rechners); $$ lässt ein $ für die Shell im Container stehen. */
const literal = (value: string): string => value.replaceAll('$', '$$$$');
const literalRecord = (record: Record<string, string> = {}): Record<string, string> =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, literal(value)]));

/** Compose-Konfiguration des Stapels (JSON ist gültiges YAML). Enthält nie ein Geheimnis. */
export function workbenchCompose(worktree: string, options: WorkbenchOptions): Record<string, unknown> {
  const platform = options.platform ?? process.platform;
  const name = workbenchName(options.project);
  const extras = options.extras ?? { services: {}, environment: {} };
  const user = sandboxUser(options);
  const workspace = `${hostMount(worktree, platform)}:${SANDBOX_WORKDIR}`;
  const modules = modulesVolume(options.project);
  const dockerData = `${name}_docker`;
  const proxy = { HTTPS_PROXY: EGRESS_URL, HTTP_PROXY: EGRESS_URL, https_proxy: EGRESS_URL, http_proxy: EGRESS_URL };
  const noProxy = { NO_PROXY: SANDBOX_NO_PROXY, no_proxy: SANDBOX_NO_PROXY };
  const shared = { network_mode: 'service:workbench', depends_on: ['workbench'], restart: 'unless-stopped' };
  const services: Record<string, unknown> = {
    workbench: {
      image: options.image ?? SANDBOX_IMAGE,
      container_name: workbenchContainer(options.project),
      command: WORKBENCH_START.map(literal),
      ...(user ? { user } : {}),
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
      cpus: Number(options.cpus ?? (process.env.DEV_LOG_AGENT_SANDBOX_CPUS?.trim() || '4')),
      mem_limit: options.memory ?? (process.env.DEV_LOG_AGENT_SANDBOX_MEMORY?.trim() || '6g'),
      pids_limit: 4096,
      restart: 'unless-stopped',
      networks: ['agents'],
      volumes: [workspace, `${modules}:${SANDBOX_WORKDIR}/node_modules`],
      working_dir: SANDBOX_WORKDIR,
      environment: {
        HOME: SANDBOX_HOME,
        CLAUDE_PROJECT_DIR: SANDBOX_WORKDIR,
        DEV_LOG_OLLAMA_URL: SANDBOX_OLLAMA_URL,
        DOCKER_HOST: WORKBENCH_DOCKER_HOST,
        ...proxy,
        ...noProxy,
        npm_config_https_proxy: EGRESS_URL,
        npm_config_proxy: EGRESS_URL,
        ...literalRecord(extras.environment),
      },
      labels: { [WORKBENCH_LABEL]: options.project, 'aideation.workbench.image': options.imageId ?? '' },
    },
    docker: {
      image: WORKBENCH_DOCKER_IMAGE,
      container_name: workbenchContainer(options.project, 'docker'),
      privileged: true,
      ...shared,
      // Ausdrücklich „dockerd“: sonst hängt das Entrypoint-Skript tcp://0.0.0.0:2375 an – erreichbar aus dem ganzen
      // Agent-Netzwerk, also aus den Stapeln anderer Projekte. Ohne TLS nur auf 127.0.0.1 (gemeinsamer Namensraum).
      command: ['dockerd', '--host=unix:///var/run/docker.sock', '--host=tcp://127.0.0.1:2375', '--tls=false'],
      // up --wait wartet so, bis Docker antwortet – der erste Befehl darf es schon brauchen.
      healthcheck: { test: ['CMD', 'docker', 'info'], interval: '2s', timeout: '5s', retries: 60, start_period: '5s' },
      environment: { DOCKER_TLS_CERTDIR: '', ...proxy, ...noProxy },
      // Gleicher Pfad wie in der workbench: Bind-Mounts aus Compose-Dateien der Agents (./src:/app) gelten hier.
      volumes: [workspace, `${dockerData}:/var/lib/docker`],
      labels: { [WORKBENCH_LABEL]: options.project },
    },
  };
  for (const [service, extra] of Object.entries(extras.services)) {
    services[service] = {
      image: extra.image,
      container_name: workbenchContainer(options.project, service),
      ...shared,
      cap_drop: ['ALL'],
      cap_add: ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE', 'FOWNER'],
      security_opt: ['no-new-privileges:true'],
      ...(extra.environment && Object.keys(extra.environment).length
        ? { environment: literalRecord(extra.environment) }
        : {}),
      ...(extra.command ? { command: extra.command.map(literal) } : {}),
      ...(extra.tmpfs?.length ? { tmpfs: extra.tmpfs } : {}),
      labels: { [WORKBENCH_LABEL]: options.project },
    };
  }
  return {
    name,
    services,
    networks: { agents: { name: SANDBOX_NETWORK, external: true } },
    volumes: { [modules]: { name: modules, external: true }, [dockerData]: { name: dockerData } },
  };
}

/** Fingerabdruck der Konfiguration: Ändert sie sich (Image, Projektdienste, Grenzen), wird der Stapel neu erstellt. */
export function workbenchHash(compose: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(compose)).digest('hex').slice(0, 16);
}

/** Ablage der Compose-Dateien (Konfiguration des Workers, nicht im Projekt und nicht für Agents erreichbar). */
export function workbenchDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.DEV_LOG_WORKBENCH_DIR?.trim();
  if (configured) return configured;
  // Tests schreiben nie in die echte Konfiguration des Workers.
  if (environment.NODE_TEST_CONTEXT) return join(tmpdir(), 'aideation-workbench-test');
  return join(homedir(), '.config', 'aideation', 'workbench');
}

const failed = (error: unknown): CommandResult => ({ exitCode: 1, durationMs: 0, output: String(error) });
/**
 * Zuletzt gestarteter Fingerabdruck je Projekt. Je Projekt gibt es nur einen Stapel: Ein Schlüssel „Name:Hash“ hielte
 * einen früheren Stand (z. B. den Agent-Worktree) für bereit, nachdem das Merge-Gate den Stapel mit dem Ordner der
 * Menschen neu erstellt hat – der nächste Agent hätte dann dort gearbeitet.
 */
const ready = new Map<string, { hash: string; pending: Promise<string | null> }>();

/**
 * Startet den Stapel, falls er fehlt oder seine Konfiguration veraltet ist (Label mit dem Fingerabdruck). Liefert ein
 * Problem (fail-closed: nichts läuft dann auf dem Host) oder null.
 */
export function ensureWorkbench(
  docker: CommandExecutor,
  worktree: string,
  options: WorkbenchOptions & { runId: string; environment?: NodeJS.ProcessEnv },
): Promise<string | null> {
  const compose = workbenchCompose(worktree, options);
  const hash = workbenchHash(compose);
  const name = workbenchName(options.project);
  const cached = ready.get(name);
  if (cached?.hash === hash) return cached.pending;
  const entry = {
    hash,
    pending: startWorkbench(docker, worktree, options, compose, hash).then((problem) => {
      if (problem && ready.get(name) === entry) ready.delete(name);
      return problem;
    }),
  };
  ready.set(name, entry);
  return entry.pending;
}

/** Nur für Tests: vergisst gestartete Stapel. */
export function resetWorkbenches(): void {
  ready.clear();
}

async function startWorkbench(
  docker: CommandExecutor,
  worktree: string,
  options: WorkbenchOptions & { runId: string; environment?: NodeJS.ProcessEnv },
  compose: Record<string, unknown>,
  hash: string,
): Promise<string | null> {
  const env = dockerClientEnvironment(options.environment);
  const name = workbenchName(options.project);
  const run = (command: string[], timeoutMs = CHECK_TIMEOUT_MS): Promise<CommandResult> =>
    docker(command, worktree, { timeoutMs, env }).catch(failed);
  const state = await run([
    'docker',
    'inspect',
    '--format',
    `{{.State.Running}} {{index .Config.Labels "${WORKBENCH_HASH_LABEL}"}}`,
    workbenchContainer(options.project),
  ]);
  if (state.exitCode === 0 && state.output.trim() === `true ${hash}`) return null;
  const volume = await prepareModulesVolume(docker, { ...options, runId: options.runId }, env, worktree);
  if (volume.exitCode !== 0)
    return `Arbeitscontainer: node_modules-Volume „${modulesVolume(options.project)}“ liess sich nicht vorbereiten. ${volume.output.trim().slice(-300)}`;
  const directory = workbenchDirectory(options.environment);
  const file = join(directory, `${name}.json`);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const labelled = structuredClone(compose) as { services: Record<string, { labels?: Record<string, string> }> };
    const service = defined(labelled.services.workbench, 'Dienst workbench');
    service.labels = { ...service.labels, [WORKBENCH_HASH_LABEL]: hash };
    writeFileSync(file, `${JSON.stringify(labelled, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    return `Arbeitscontainer: Compose-Datei liess sich nicht schreiben (${file}). ${String(error)}`;
  }
  const up = await run(
    ['docker', 'compose', '-f', file, '-p', name, 'up', '-d', '--remove-orphans', '--wait'],
    COMPOSE_TIMEOUT_MS,
  );
  if (up.exitCode !== 0)
    return `Arbeitscontainer „${name}“ startet nicht – der Agent wurde nicht gestartet. ${redactOutput(up.output, process.env).trim().slice(-500)}`;
  return null;
}

/** Datei mit der Prozessgruppe eines Laufs im Container (für den Abbruch). */
const pidFile = (runId: string): string => `/tmp/aideation-run-${runId.replace(/[^\w.-]+/g, '-')}.pid`;

/** docker exec eines Laufs: eigene Prozessgruppe (setsid -w), deren Nummer im pid-File steht. Nie ein Geheimniswert. */
export function workbenchExecArgs(
  command: string[],
  worktree: string,
  options: Pick<SandboxOptions, 'project' | 'runId' | 'environment' | 'passEnv' | 'platform' | 'uid' | 'gid'> & {
    cwd?: string;
  },
): string[] {
  const environment = options.environment ?? process.env;
  const credentials = [...SANDBOX_CREDENTIALS, ...(options.passEnv ?? [])].filter((name) => environment[name]);
  const user = sandboxUser(options);
  return [
    'docker',
    'exec',
    ...(user ? ['--user', user] : []),
    '-w',
    containerDirectory(worktree, options.cwd),
    '-e',
    `AIDEATION_RUN=${options.runId}`,
    ...credentials.flatMap((name) => ['-e', name]),
    workbenchContainer(options.project),
    // -w: warten und den Exit-Code weitergeben (ohne -w forkt setsid und kehrt sofort zurück).
    'setsid',
    '-w',
    'sh',
    '-c',
    `echo $$ > ${pidFile(options.runId)}; exec "$@"`,
    'aideation',
    ...containerCommand(command),
  ];
}

const installs = new Map<string, Promise<CommandResult>>();

/**
 * Führt einen Befehl im Arbeitscontainer des Projekts aus – gleiches Ergebnis wie runInSandbox (Streaming, Timeout,
 * Abbruch, geschwärzte Ausgabe). Ein Abbruch beendet die Prozessgruppe im Container, nicht nur den Client.
 */
export async function runInWorkbench(
  command: string[],
  worktree: string,
  options: SandboxOptions &
    NonNullable<Parameters<CommandExecutor>[2]> & {
      cwd?: string;
      docker?: CommandExecutor;
    },
): Promise<CommandResult> {
  const { docker = runCommand, signal, timeoutMs, onSpawn, onOutput, onChunk } = options;
  const source = options.environment ?? process.env;
  const redactWith = { ...process.env, ...source };
  if (signal?.aborted) return { exitCode: 130, durationMs: 0, output: 'Abgebrochen, bevor der Lauf startete.\n' };
  const env = dockerClientEnvironment(source, options.passEnv);
  const startedAt = Date.now();
  const problem = await sandboxProblem(docker, { image: options.image, environment: source, cwd: worktree });
  if (problem) {
    noteProblem(options.project, problem);
    return blocked(problem, redactWith);
  }
  const missing = credentialProblem(command, source);
  if (missing) {
    noteProblem(options.project, missing);
    return blocked(missing, redactWith);
  }
  const network = await ensureAgentNetwork(docker, {
    environment: source,
    cwd: worktree,
    platform: options.platform,
    image: options.image,
  });
  if (network) {
    noteProblem(options.project, network);
    return blocked(network, redactWith);
  }
  let extras: WorkbenchExtras;
  try {
    extras = readWorkbenchExtras(mainCheckout(worktree));
  } catch (error) {
    return blocked(`Arbeitscontainer: ${WORKBENCH_FILE} ist ungültig – ${String(error)}`, redactWith);
  }
  const image = await docker(
    ['docker', 'image', 'inspect', '--format', '{{.Id}}', options.image ?? SANDBOX_IMAGE],
    worktree,
    { timeoutMs: CHECK_TIMEOUT_MS, env },
  ).catch(failed);
  const imageId = image.exitCode === 0 ? image.output.trim() : '';
  const started = await ensureWorkbench(docker, worktree, { ...options, extras, imageId, environment: source });
  if (started) {
    noteProblem(options.project, started);
    return blocked(started, redactWith);
  }
  if (options.dependencies !== false) {
    const stamp = dependencyStamp(worktree);
    if (stamp) {
      const key = `${workbenchName(options.project)}:${stamp}`;
      let install = installs.get(key);
      if (!install) {
        install = runInWorkbench(dependencyCommand(stamp), worktree, {
          ...options,
          cwd: worktree,
          runId: `${options.runId}-npm`,
          dependencies: false,
          timeoutMs: INSTALL_TIMEOUT_MS,
          onSpawn: undefined,
          onOutput: undefined,
          onChunk: undefined,
        }).finally(() => installs.delete(key));
        installs.set(key, install);
      }
      const installed = await install;
      if (installed.exitCode !== 0) {
        const message = `Arbeitscontainer: Abhängigkeiten liessen sich nicht installieren (Exit-Code ${installed.exitCode}). Befehl nicht gestartet.\n${installed.output.trim().slice(-800)}`;
        noteProblem(options.project, defined(message.split('\n')[0]));
        return blocked(message, redactWith);
      }
    }
  }
  noteProblem(options.project, null);
  if (signal?.aborted) return { exitCode: 130, durationMs: 0, output: 'Abgebrochen, bevor der Lauf startete.\n' };
  const name = workbenchContainer(options.project);
  const args = workbenchExecArgs(command, worktree, { ...options, environment: source });
  let killing: Promise<unknown> | null = null;
  const killGroup = (): Promise<unknown> => {
    const file = pidFile(options.runId);
    killing ??= docker(
      [
        'docker',
        'exec',
        name,
        'sh',
        '-c',
        `p=$(cat ${file} 2>/dev/null) && kill -TERM -"$p" 2>/dev/null; rm -f ${file}`,
      ],
      worktree,
      { timeoutMs: KILL_TIMEOUT_MS, env },
    ).catch(() => undefined);
    return killing;
  };
  const onAbort = (): void => void killGroup();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = timeoutMs ? setTimeout(onAbort, timeoutMs) : undefined;
  let result: CommandResult;
  try {
    result = await docker(args, worktree, { timeoutMs, env, signal, onSpawn, onOutput, onChunk });
  } catch (error) {
    result = { exitCode: 1, durationMs: 0, output: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (killing) await killing;
  }
  const note = signal?.aborted ? null : sandboxFailureNote(result.exitCode, result.output);
  if (note && /^Sandbox:/.test(note)) noteProblem(options.project, note);
  return {
    ...result,
    durationMs: Date.now() - startedAt,
    output: redactOutput(note ? `${result.output}\n\n${note}\n` : result.output, redactWith),
  };
}

/**
 * Beendet alle Läufe eines Vorgängers in den Arbeitscontainern (Prozessgruppen aus den pid-Dateien), zuerst mit TERM,
 * nach ein paar Sekunden mit KILL. Nötig beim Start des Workers: killPreviousProcesses beendet nur den Client von
 * „docker exec“ auf dem Rechner, der Prozess im Container (Agent, Test, npm) liefe sonst neben dem neu eingeplanten
 * Lauf im selben Worktree weiter. Gruppe 1 (sleep infinity, hält den Container) wird nie angefasst.
 */
export async function stopLeftoverWorkbenchRuns(
  docker: CommandExecutor = runCommand,
  cwd: string = process.cwd(),
): Promise<number> {
  const env = dockerClientEnvironment();
  const list = await docker(['docker', 'ps', '--filter', `label=${WORKBENCH_LABEL}`, '--format', '{{.Names}}'], cwd, {
    timeoutMs: CHECK_TIMEOUT_MS,
    env,
  }).catch(() => null);
  if (!list || list.exitCode !== 0) return 0;
  const containers = list.output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^agents_[a-z0-9-]+_workbench$/.test(line));
  const script = [
    'groups=""',
    'for f in /tmp/aideation-run-*.pid; do',
    '  [ -f "$f" ] || continue',
    '  p=$(cat "$f" 2>/dev/null); rm -f "$f"',
    '  case "$p" in ""|*[!0-9]*) continue;; esac',
    '  [ "$p" -gt 1 ] || continue',
    '  kill -TERM -"$p" 2>/dev/null && groups="$groups $p"',
    'done',
    '[ -n "$groups" ] || exit 0',
    'sleep 3',
    'for p in $groups; do kill -KILL -"$p" 2>/dev/null; done',
    'echo $groups | wc -w',
  ].join('\n');
  let stopped = 0;
  for (const container of containers) {
    const result = await docker(['docker', 'exec', container, 'sh', '-c', script], cwd, {
      timeoutMs: KILL_TIMEOUT_MS + 5_000,
      env,
    }).catch(() => null);
    if (result?.exitCode === 0) stopped += Number.parseInt(result.output.trim(), 10) || 0;
  }
  return stopped;
}
