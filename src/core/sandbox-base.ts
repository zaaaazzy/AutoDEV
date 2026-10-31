import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { READ_ONLY_ROLES } from './permission-rules.js';
import { type CommandExecutor, type CommandResult, redactOutput, runCommand } from './command.js';

/**
 * Docker-Sandbox für Agents (Schalter DEV_LOG_AGENT_SANDBOX, global und je Projekt: off, docker oder workbench, Standard
 * workbench). Im Modus „docker“ läuft jeder Agent und jeder Projekttest in einem kurzlebigen Container (Image
 * aideation-agent, deploy/agent/Dockerfile) statt direkt auf dem Host; im Modus „workbench“ gehen schreibende Läufe in
 * den Arbeitscontainer des Projekts (workbench.ts), lesende Läufe, Schätzung und Vorschau bleiben kurzlebig.
 * Eingebunden ist nur der Worktree des Auftrags als /workspace (für lesende Rollen nur :ro) und node_modules als Volume
 * je Projekt – kein Docker-Socket, kein Home, kein ~/.ssh oder ~/.claude, keine .env des Hosts. Netzwerk: das interne
 * Netzwerk aideation-agents, hinaus nur über den Egress-Proxy (egress-proxy.ts) zu Anthropic-API, npm-Registry, Docker
 * Hub und Ollama auf dem Host (egressAllowList). Der Worker steuert den Lauf – auf dem Host oder als Compose-Dienst
 * worker (src/core/worker-container.ts), dort über den eingebundenen Docker-Socket.
 */

export type SandboxMode = 'off' | 'docker' | 'workbench';

export const SANDBOX_IMAGE = 'aideation-agent';
export const SANDBOX_LABEL = 'aideation.run';
export const SANDBOX_WORKDIR = '/workspace';
export const SANDBOX_HOME = '/home/agent';
/** Wächter im Image (deploy/agent/Dockerfile bündelt agent-guard.ts dorthin). */
export const SANDBOX_GUARD = { node: 'node', script: '/opt/aideation/agent-guard.mjs' } as const;
/** Internes Docker-Netzwerk der Agent-Container: keine Route nach aussen, nur zum Egress-Proxy. */
export const SANDBOX_NETWORK = 'aideation-agents';
/** Egress-Proxy: einziger Weg aus dem Agent-Netzwerk (Allowlist in egress-proxy.ts). */
export const EGRESS_CONTAINER = 'aideation-egress';
export const EGRESS_PORT = 3128;
export const EGRESS_URL = `http://${EGRESS_CONTAINER}:${EGRESS_PORT}`;
const EGRESS_LABEL = 'aideation.egress';
const EGRESS_SCRIPT = '/opt/aideation/egress-proxy.mjs';
/**
 * Anmeldung der Claude-CLI im Container: nur der Name geht in die Befehlszeile (-e NAME), den Wert liest der
 * Docker-Client aus seiner Umgebung (worker.env). So steht der Token nie in Argumenten, Logs oder Prozesslisten.
 */
export const SANDBOX_CREDENTIALS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const;
/** Ollama auf dem Host, vom Container aus gesehen. */
export const SANDBOX_OLLAMA_URL = 'http://host.docker.internal:11434';
/** Nach dem Abbruch höchstens so lange auf docker kill/rm warten. */
export const KILL_TIMEOUT_MS = 8_000;
export const CHECK_TIMEOUT_MS = 20_000;

/** Liest einen Schalterwert; unbekannte Werte gelten als nicht gesetzt. */
export function parseSandboxMode(value: unknown): SandboxMode | null {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text === 'off' || text === 'docker' || text === 'workbench' ? text : null;
}

/**
 * Wirksamer Schalter: Projekt vor global (DEV_LOG_AGENT_SANDBOX), Standard „workbench“ (dauerhafter Arbeitscontainer
 * je Projekt mit eigenem Docker, workbench.ts); „docker“ ist der kurzlebige Container je Lauf. „off“ ist der ausdrückliche
 * Notfallmodus (Agents und Tests wieder auf dem Host) und zeigt im Worker-Badge eine Warnung. Ausnahme ohne
 * ausdrückliche Angabe: unter dem Node-Test-Runner (NODE_TEST_CONTEXT) gilt „off“ – Unit-Tests arbeiten mit
 * Attrappen, und im Testcontainer gibt es ohnehin kein Docker. So bleiben auch Einzelaufrufe wie
 * „npx tsx --test datei.test.ts“ (Testbefehle je Auftrag) unabhängig vom Standard.
 */
export function sandboxMode(projectValue: unknown, environment: NodeJS.ProcessEnv = process.env): SandboxMode {
  return (
    parseSandboxMode(projectValue) ??
    parseSandboxMode(environment.DEV_LOG_AGENT_SANDBOX) ??
    (environment.NODE_TEST_CONTEXT ? 'off' : 'workbench')
  );
}

/** Läuft ein Agent bzw. Projekttest im Container? Gilt für alle Rollen, sobald der Modus nicht „off“ ist. */
export function usesSandbox(mode: SandboxMode): boolean {
  return mode !== 'off';
}

/** Lesende Rollen (Visionär, Problemanalyse, Vor dem Sprint …) bekommen den Workspace nur als :ro. */
export function readOnlyWorkspace(role: string): boolean {
  return READ_ONLY_ROLES.has(role);
}

/** Warnung fürs Worker-Badge, wenn die Sandbox ausdrücklich ausgeschaltet ist (Notfallmodus). */
export function sandboxOffWarning(mode: SandboxMode): string | null {
  return mode === 'off'
    ? 'Notfallmodus: Docker-Sandbox aus (DEV_LOG_AGENT_SANDBOX=off) – Agents und Projekttests laufen auf dem Host.'
    : null;
}

/** Host-Pfad für -v: unter Windows im Format von Docker Desktop (C:\Users\a → /c/Users/a). */
export function dockerHostPath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return path;
  const drive = /^([a-zA-Z]):[\\/]*(.*)$/.exec(path);
  if (!drive) return path.replaceAll('\\', '/');
  const rest = drive[2].replaceAll('\\', '/').replace(/\/+$/, '');
  return `/${drive[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
}

/** Benanntes Volume für node_modules je Projekt (Linux-Binärdateien, darum nicht die des Hosts). */
export function modulesVolume(project: string): string {
  const safe = project
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[-.]+/, '');
  return `aideation-node-modules-${safe || 'projekt'}`;
}

export interface SandboxOptions {
  /** Lauf-ID (Label aideation.run, Aufräumen beim Start des Workers). */
  runId: string;
  /** Projekt-Slug (Name des node_modules-Volumes). */
  project: string;
  platform?: NodeJS.Platform;
  /** Benutzer des Containers; Standard: der Worker-Benutzer (unter Windows entfällt --user). */
  uid?: number;
  gid?: number;
  cpus?: string;
  memory?: string;
  image?: string;
  /** Name des Containers (für docker kill); Standard: zufällig je Lauf. */
  name?: string;
  /** Umgebung des Docker-Clients; daraus kommen die Werte der Anmeldedaten. */
  environment?: NodeJS.ProcessEnv;
  /** Workspace und node_modules nur lesend einbinden (:ro), etwa für Visionär und Problemanalyse. */
  readOnly?: boolean;
  /** Worktree nicht einbinden (z. B. Aufnahme der Vorschau mit Playwright); Standard: eingebunden. */
  workspace?: boolean;
  /** Ordner des Hosts, der als /out beschreibbar eingebunden wird (Ergebnisse von AIdeation-Skripten im Image). */
  outputDir?: string;
  /**
   * Netzwerk des Containers. Standard: das interne Agent-Netzwerk mit Egress-Proxy. Projekttests mit Diensten laufen
   * nur im Compose-Netzwerk des Projekts; „bridge“ nur für AIdeation-eigene Skripte ohne Worktree (Vorschau-Aufnahme).
   */
  network?: string;
  /** Weitere Variablen, die nur als Name (-e NAME) weitergehen; den Wert liest der Docker-Client aus seiner Umgebung. */
  passEnv?: readonly string[];
  /** Abhängigkeiten vor dem Lauf ins node_modules-Volume installieren (Standard: ja, ausser bei :ro). */
  dependencies?: boolean;
  /**
   * Wirksamer Schalter des Projekts. „workbench“: schreibende Läufe gehen in den Arbeitscontainer des Projekts
   * (workbench.ts); lesende (:ro) und Läufe ohne Worktree bleiben kurzlebige Container.
   */
  mode?: SandboxMode;
}

/** Host-Pfad im Format von docker -v. */
export function hostMount(path: string, platform: NodeJS.Platform): string {
  return dockerHostPath((platform === 'win32' ? win32 : posix).resolve(path), platform);
}

/**
 * Ziele im Container selbst: nie über den Proxy. Sonst antwortet er für localhost (Playwright meldet den Port als
 * belegt, Tests gegen einen eigenen Server im Container scheitern).
 */
export const SANDBOX_NO_PROXY = 'localhost,127.0.0.1,::1,0.0.0.0';

/** Proxy-Variablen für das Agent-Netzwerk: Claude-CLI, npm und Playwright gehen nur über den Egress-Proxy. */
export function proxyEnvironment(): string[] {
  return ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'npm_config_https_proxy', 'npm_config_proxy']
    .flatMap((name) => ['-e', `${name}=${EGRESS_URL}`])
    .concat(['NO_PROXY', 'no_proxy'].flatMap((name) => ['-e', `${name}=${SANDBOX_NO_PROXY}`]));
}

/** Host-Pfade gehören nicht in den Container: die CLI heisst im Image einfach „claude“. */
export function containerCommand(command: string[]): string[] {
  const [binary, ...rest] = command;
  if (!binary) return command;
  const name = basename(binary.replaceAll('\\', '/'));
  return [name === 'claude' || name === 'claude.exe' || name === 'claude.cmd' ? 'claude' : binary, ...rest];
}

/** Arbeitsordner im Container: derselbe Unterordner des Worktrees unter /workspace. */
export function containerDirectory(worktree: string, cwd: string | undefined): string {
  if (!cwd) return SANDBOX_WORKDIR;
  const inner = relative(resolve(worktree), resolve(cwd));
  if (!inner || inner.startsWith('..') || isAbsolute(inner)) return SANDBOX_WORKDIR;
  return `${SANDBOX_WORKDIR}/${inner.split(sep).join('/')}`;
}

export function sandboxUser(options: Pick<SandboxOptions, 'platform' | 'uid' | 'gid'>): string | null {
  if ((options.platform ?? process.platform) === 'win32') return null;
  const uid = options.uid ?? process.getuid?.();
  const gid = options.gid ?? process.getgid?.();
  return uid === undefined || gid === undefined ? null : `${uid}:${gid}`;
}

/** Name des Containers eines Laufs. */
export function containerName(runId: string): string {
  return `aideation-${runId.replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 60)}-${randomUUID().slice(0, 8)}`;
}

/**
 * Befehlszeile von docker run. Enthält nie den Wert eines Geheimnisses: Anmeldedaten nur als Name (-e NAME).
 */
export function sandboxRunArgs(
  command: string[],
  worktree: string,
  options: SandboxOptions & { name: string; cwd?: string },
): string[] {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const user = sandboxUser(options);
  const credentials = [...SANDBOX_CREDENTIALS, ...(options.passEnv ?? [])].filter((name) => environment[name]);
  const network = options.network ?? SANDBOX_NETWORK;
  const mode = options.readOnly ? ':ro' : '';
  const mounts =
    options.workspace === false
      ? []
      : [
          '-v',
          `${hostMount(worktree, platform)}:${SANDBOX_WORKDIR}${mode}`,
          '-v',
          `${modulesVolume(options.project)}:${SANDBOX_WORKDIR}/node_modules${mode}`,
        ];
  return [
    'docker',
    'run',
    '--rm',
    '--name',
    options.name,
    '--label',
    `${SANDBOX_LABEL}=${options.runId}`,
    ...(user ? ['--user', user] : []),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    // Grenzen aus der Worker-Umgebung: die Agent-Umgebung enthält keine DEV_LOG_*-Werte.
    '--cpus',
    options.cpus ?? (process.env.DEV_LOG_AGENT_SANDBOX_CPUS?.trim() || '2'),
    '--memory',
    options.memory ?? (process.env.DEV_LOG_AGENT_SANDBOX_MEMORY?.trim() || '4g'),
    '--pids-limit',
    '2048',
    '--network',
    network,
    // Im internen Agent-Netzwerk führt kein Weg zum Host; Ollama erreicht der Container dort über den Egress-Proxy.
    ...(platform === 'linux' && network !== SANDBOX_NETWORK ? ['--add-host', 'host.docker.internal:host-gateway'] : []),
    ...mounts,
    ...(options.outputDir ? ['-v', `${hostMount(options.outputDir, platform)}:/out`] : []),
    '-w',
    containerDirectory(worktree, options.cwd),
    '-e',
    `HOME=${SANDBOX_HOME}`,
    '-e',
    `CLAUDE_PROJECT_DIR=${SANDBOX_WORKDIR}`,
    '-e',
    `DEV_LOG_OLLAMA_URL=${SANDBOX_OLLAMA_URL}`,
    ...(network === SANDBOX_NETWORK ? proxyEnvironment() : []),
    ...credentials.flatMap((name) => ['-e', name]),
    options.image ?? SANDBOX_IMAGE,
    ...containerCommand(command),
  ];
}

/**
 * Umgebung des Docker-Clients: was er selbst braucht (PATH, Docker-Kontext, Proxy) und die Anmeldedaten, deren
 * Werte er per -e NAME weiterreicht. Alles andere aus der Worker-Umgebung bleibt draussen.
 */
export function dockerClientEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  extra: readonly string[] = [],
): NodeJS.ProcessEnv {
  const keep =
    /^(?:PATH|Path|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|SYSTEMROOT|SystemRoot|TEMP|TMP|TMPDIR|XDG_RUNTIME_DIR|DOCKER_[A-Z_]+|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|LANG|LC_ALL)$/;
  const allowed = new Set<string>([...SANDBOX_CREDENTIALS, ...extra]);
  return Object.fromEntries(
    Object.entries(environment).filter(([key, value]) => value !== undefined && (keep.test(key) || allowed.has(key))),
  );
}

/** Problem mit Docker oder dem Image, das den Lauf sperrt (fail-closed); null = bereit. */
export async function sandboxProblem(
  docker: CommandExecutor = runCommand,
  options: { image?: string; environment?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<string | null> {
  const image = options.image ?? SANDBOX_IMAGE;
  const env = dockerClientEnvironment(options.environment);
  const cwd = options.cwd ?? process.cwd();
  const version = await docker(['docker', 'version', '--format', '{{.Server.Version}}'], cwd, {
    timeoutMs: CHECK_TIMEOUT_MS,
    env,
  }).catch((error: unknown) => ({ exitCode: 1, durationMs: 0, output: String(error) }));
  if (version.exitCode !== 0) {
    return (
      'Sandbox (DEV_LOG_AGENT_SANDBOX): Docker ist nicht erreichbar – der Agent wurde nicht gestartet, auch ' +
      'nicht auf dem Host. Docker starten oder die Sandbox ausschalten.'
    );
  }
  const inspect = await docker(['docker', 'image', 'inspect', '--format', '{{.Id}}', image], cwd, {
    timeoutMs: CHECK_TIMEOUT_MS,
    env,
  }).catch((error: unknown) => ({ exitCode: 1, durationMs: 0, output: String(error) }));
  if (inspect.exitCode !== 0) {
    return (
      `Sandbox (DEV_LOG_AGENT_SANDBOX): Image „${image}“ fehlt – der Agent wurde nicht gestartet, auch nicht ` +
      `auf dem Host. Bauen mit „docker build -t ${image} -f deploy/agent/Dockerfile .“ im AIdeation-Ordner ` +
      '(geschieht auch bei „AIdeation neu starten“).'
    );
  }
  return null;
}

/** Fehlt die Anmeldung für die Claude-CLI im Container? Getrennt von „Docker/Image fehlt“ gemeldet. */
export function credentialProblem(command: string[], environment: NodeJS.ProcessEnv = process.env): string | null {
  if (containerCommand(command)[0] !== 'claude') return null;
  if (SANDBOX_CREDENTIALS.some((name) => environment[name])) return null;
  return (
    'Sandbox: Anmeldung der Claude-CLI fehlt – im Container gibt es kein ~/.claude des Hosts. ' +
    'CLAUDE_CODE_OAUTH_TOKEN (aus „claude setup-token“) in worker.env eintragen und den Worker neu starten.'
  );
}

/**
 * Einordnung eines gescheiterten Laufs: Docker-Fehler (Exit 125–127), Anmeldung oder Limit der Claude-CLI. So sieht
 * ein Limit-Abbruch nicht wie ein Sandbox-Fehler aus und umgekehrt.
 */
export function sandboxFailureNote(exitCode: number, output: string): string | null {
  if (exitCode === 0) return null;
  if (/spend limit|usage limit|session limit|rate limit/i.test(output)) {
    // Der Runner erkennt die Meldung (usageLimitReset) und pausiert bis zum Reset – ohne Fehlversuch und ohne Bug.
    return 'Hinweis: Die Claude-CLI hat ein Nutzungslimit gemeldet – kein Fehler der Sandbox; der Schritt pausiert bis zum Reset.';
  }
  if (
    /not logged in|please run \/login|invalid api key|authentication|oauth token|unauthori[sz]ed|\b401\b/i.test(output)
  ) {
    return 'Hinweis: Die Claude-CLI im Container ist nicht angemeldet – CLAUDE_CODE_OAUTH_TOKEN in worker.env prüfen.';
  }
  if (exitCode === 125) return 'Sandbox: Docker konnte den Container nicht starten (Exit-Code 125).';
  if (exitCode === 126 || exitCode === 127) {
    return `Sandbox: Der Befehl ist im Image „${SANDBOX_IMAGE}“ nicht ausführbar (Exit-Code ${exitCode}).`;
  }
  return null;
}

/** Zuletzt gemeldetes Sandbox-Problem je Projekt, fürs Worker-Badge (Heartbeat). */
const problems = new Map<string, string>();

export function sandboxBadge(project: string): string | null {
  return problems.get(project) ?? null;
}

export function noteProblem(project: string, problem: string | null): void {
  if (problem) problems.set(project, problem);
  else problems.delete(project);
}

export const blocked = (output: string, environment: NodeJS.ProcessEnv): CommandResult => ({
  exitCode: 1,
  durationMs: 0,
  output: `${redactOutput(output, environment)}\n`,
});

/**
 * node_modules-Volume anlegen und dem Benutzer des Containers geben: ein neues Volume gehört root, der Agent läuft
 * ohne root. Einmaliger Hilfscontainer ohne Mount des Worktrees.
 */
export async function prepareModulesVolume(
  docker: CommandExecutor,
  options: Pick<SandboxOptions, 'runId' | 'project' | 'platform' | 'uid' | 'gid' | 'image'>,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<CommandResult> {
  const user = sandboxUser(options) ?? 'pwuser:pwuser';
  return docker(
    [
      'docker',
      'run',
      '--rm',
      '--label',
      `${SANDBOX_LABEL}=${options.runId}`,
      '--user',
      '0:0',
      '--network',
      'none',
      '--entrypoint',
      'chown',
      '-v',
      `${modulesVolume(options.project)}:/modules`,
      options.image ?? SANDBOX_IMAGE,
      user,
      '/modules',
    ],
    cwd,
    { timeoutMs: CHECK_TIMEOUT_MS * 3, env },
  ).catch((error: unknown) => ({ exitCode: 1, durationMs: 0, output: String(error) }));
}

/** Stempel im node_modules-Volume: Hash der package-lock.json, mit dem zuletzt installiert wurde. */
export const DEPENDENCY_STAMP = 'node_modules/.aideation-lock';
export const INSTALL_TIMEOUT_MS = 15 * 60_000;

/** Hash der package-lock.json (sonst package.json) im Worktree; null ohne package.json. */
export function dependencyStamp(worktree: string): string | null {
  const manifest = join(worktree, 'package.json');
  if (!existsSync(manifest)) return null;
  const lock = join(worktree, 'package-lock.json');
  return createHash('sha256')
    .update(readFileSync(existsSync(lock) ? lock : manifest))
    .digest('hex')
    .slice(0, 16);
}

/** Sperrdatei im Volume: hält die Installation fest, solange sie läuft (flock, auch über Worker-Neustarts hinweg). */
export const DEPENDENCY_LOCK = 'node_modules/.aideation-install.lock';

/**
 * Installiert nur, wenn der Stempel im Volume nicht passt, und dann frisch (Reste eines abgebrochenen Laufs liessen
 * npm mit ENOTEMPTY scheitern; der Cache bleibt). npm install statt npm ci: node_modules ist ein Mountpunkt,
 * den npm ci löschen wollte. Ohne Installationsskripte, wie bei den Agents; der Cache liegt im Volume (HOME ist im
 * Container nicht beschreibbar). Die Sperre gilt für alle Container am selben Volume: Startet der Worker neu, während
 * npm im Arbeitscontainer weiterläuft, wartet die nächste Installation und prüft danach den Stempel (sonst ENOENT).
 */
export function dependencyCommand(stamp: string): string[] {
  return [
    'sh',
    '-c',
    `exec 9>${DEPENDENCY_LOCK} && flock 9 && ` +
      `{ [ "$(cat ${DEPENDENCY_STAMP} 2>/dev/null)" = "${stamp}" ] || ` +
      '{ find node_modules -mindepth 1 -maxdepth 1 ! -name .cache ! -name .aideation-install.lock -exec rm -rf {} + && ' +
      `npm install --ignore-scripts --no-audit --no-fund --cache node_modules/.cache/npm && echo ${stamp} > ${DEPENDENCY_STAMP}; }; }`,
  ];
}

/** Docker Hub: Registry, Anmeldung und CDN der Image-Schichten. */
export const DOCKER_HUB_HOSTS = [
  'registry-1.docker.io:443',
  'auth.docker.io:443',
  'production.cloudflare.docker.com:443',
  'production.cloudfront.docker.com:443',
];

/** Erlaubte Ziele des Egress-Proxys (siehe egress-proxy.ts); weitere über DEV_LOG_AGENT_SANDBOX_EGRESS (host:port, …). */
export function egressAllowList(environment: NodeJS.ProcessEnv = process.env): string {
  const extra = (environment.DEV_LOG_AGENT_SANDBOX_EGRESS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => /^[a-z0-9.-]+:\d{1,5}$/.test(entry));
  return [
    'api.anthropic.com:443',
    'registry.npmjs.org:443',
    'host.docker.internal:11434',
    // Docker im Arbeitscontainer (workbench.ts) lädt Images von Docker Hub.
    ...DOCKER_HUB_HOSTS,
    ...extra,
  ].join(',');
}

/** docker run des Egress-Proxys: am normalen Bridge-Netzwerk (Weg nach aussen), ohne Rechte, ohne Mounts. */
export function egressRunArgs(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  image = SANDBOX_IMAGE,
): string[] {
  return [
    'docker',
    'run',
    '-d',
    '--name',
    EGRESS_CONTAINER,
    '--label',
    `${EGRESS_LABEL}=1`,
    '--restart',
    'unless-stopped',
    '--network',
    'bridge',
    ...(platform === 'linux' ? ['--add-host', 'host.docker.internal:host-gateway'] : []),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--memory',
    '256m',
    '--pids-limit',
    '128',
    '-e',
    `AIDEATION_EGRESS_ALLOW=${egressAllowList(environment)}`,
    '-e',
    `AIDEATION_EGRESS_PORT=${EGRESS_PORT}`,
    image,
    'node',
    EGRESS_SCRIPT,
  ];
}

const failed = (error: unknown): CommandResult => ({ exitCode: 1, durationMs: 0, output: String(error) });

/** Einmal je Worker-Prozess (und nach einem Fehler erneut): Netzwerk und Proxy bereitstellen. */
let egressReady: Promise<string | null> | null = null;

/**
 * Stellt das interne Agent-Netzwerk und den Egress-Proxy bereit. Liefert ein Problem (fail-closed) oder null. Das
 * Netzwerk ist --internal: Ein Agent-Container erreicht weder LAN noch Host noch die AIdeation-Datenbank, nur den
 * Proxy. Ein gleichnamiges, nicht internes Netzwerk gilt als Problem und wird nicht still verwendet.
 */
export function ensureAgentNetwork(
  docker: CommandExecutor = runCommand,
  options: { environment?: NodeJS.ProcessEnv; cwd?: string; platform?: NodeJS.Platform; image?: string } = {},
): Promise<string | null> {
  egressReady ??= prepareAgentNetwork(docker, options).then((problem) => {
    if (problem) egressReady = null;
    return problem;
  });
  return egressReady;
}

/** Nur für Tests: vergisst den bereitgestellten Proxy. */
export function resetAgentNetwork(): void {
  egressReady = null;
}

async function prepareAgentNetwork(
  docker: CommandExecutor,
  options: { environment?: NodeJS.ProcessEnv; cwd?: string; platform?: NodeJS.Platform; image?: string },
): Promise<string | null> {
  const env = dockerClientEnvironment(options.environment);
  const cwd = options.cwd ?? process.cwd();
  const run = (command: string[]): Promise<CommandResult> =>
    docker(command, cwd, { timeoutMs: CHECK_TIMEOUT_MS * 3, env }).catch(failed);
  const prefix = `Sandbox: Agent-Netzwerk „${SANDBOX_NETWORK}“`;
  const inspect = await run(['docker', 'network', 'inspect', '--format', '{{.Internal}}', SANDBOX_NETWORK]);
  if (inspect.exitCode !== 0) {
    const created = await run([
      'docker',
      'network',
      'create',
      '--internal',
      '--label',
      'aideation.network=agents',
      SANDBOX_NETWORK,
    ]);
    if (created.exitCode !== 0 && !/already exists/i.test(created.output))
      return `${prefix} liess sich nicht anlegen – der Agent wurde nicht gestartet. ${created.output.trim().slice(-300)}`;
  } else if (inspect.output.trim() !== 'true') {
    return `${prefix} ist nicht intern (--internal) – der Agent wurde nicht gestartet. Netzwerk mit „docker network rm ${SANDBOX_NETWORK}“ entfernen; AIdeation legt es neu an.`;
  }
  const state = await run(['docker', 'inspect', '--format', '{{.State.Running}}', EGRESS_CONTAINER]);
  if (state.exitCode === 0 && state.output.trim() === 'true') {
    // Läuft schon; sicherstellen, dass er auch im Agent-Netzwerk hängt (z. B. nach einem neu angelegten Netzwerk).
    const joined = await run(['docker', 'network', 'connect', SANDBOX_NETWORK, EGRESS_CONTAINER]);
    if (joined.exitCode !== 0 && !/already exists|already attached|endpoint with name/i.test(joined.output))
      return `Sandbox: Egress-Proxy „${EGRESS_CONTAINER}“ hängt nicht im Agent-Netzwerk. ${joined.output.trim().slice(-300)}`;
    return null;
  }
  await run(['docker', 'rm', '-f', EGRESS_CONTAINER]);
  const started = await run(egressRunArgs(options.platform, options.environment, options.image));
  if (started.exitCode !== 0)
    return `Sandbox: Egress-Proxy „${EGRESS_CONTAINER}“ startet nicht – der Agent wurde nicht gestartet. ${started.output.trim().slice(-300)}`;
  const connected = await run(['docker', 'network', 'connect', SANDBOX_NETWORK, EGRESS_CONTAINER]);
  if (connected.exitCode !== 0)
    return `Sandbox: Egress-Proxy liess sich nicht mit „${SANDBOX_NETWORK}“ verbinden. ${connected.output.trim().slice(-300)}`;
  return null;
}
