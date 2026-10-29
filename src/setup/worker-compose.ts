/**
 * docker-compose.override.yml für den Worker im Container (Dienste worker und watchdog, Profil worker). Compose lädt
 * die Datei neben docker-compose.yml automatisch. Sie enthält, was vom Rechner abhängt und sich in Compose nicht
 * aufzählen lässt: den AIdeation-Ordner und die Projektordner (DEV_LOG_PROJECT_ROOTS), jeweils mit demselben Pfad wie
 * auf dem Host – der Worker gibt diese Pfade an docker run weiter, und der Docker-Daemon löst sie auf dem Host auf.
 * Unter Windows gilt der Pfad von Docker Desktop (C:\Users\a → /c/Users/a). Dazu kommen die Git-Zugänge, nur für den
 * Worker und nur schreibgeschützt. Erzeugt von start.sh/start.cmd und vom Einrichtungs-Assistenten
 * (scripts/worker-compose.ts); von Hand angelegte Dateien ohne Kennzeichnung werden nie überschrieben.
 */
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { parseEnv } from '../core/env-file.js';
import { dockerHostPath } from '../core/sandbox.js';
import { projectRoots } from '../core/validation.js';

export const OVERRIDE_FILE = 'docker-compose.override.yml';
/** Erste Zeile jeder erzeugten Datei: nur solche Dateien schreibt AIdeation neu. */
export const OVERRIDE_MARKER = '# Erzeugt von AIdeation (scripts/worker-compose.ts)';
/** Home des Worker-Images (deploy/worker/Dockerfile). */
const WORKER_HOME = '/home/worker';

/** Git-Zugänge des Hosts für den Worker (Host-Pfade); fehlende bleiben weg. */
export interface WorkerCredentials {
  /** ~/.ssh (Schlüssel, known_hosts, config). */
  sshDir?: string | null;
  /** Konfiguration der GitHub-CLI (~/.config/gh). */
  ghConfigDir?: string | null;
  /** ~/.gitconfig (Name und E-Mail für Commits). */
  gitConfig?: string | null;
  /** Datei mit einem GitHub-Token (z. B. aus „gh auth token“), wenn gh den Token im Schlüsselbund hält. */
  githubTokenFile?: string | null;
}

export interface WorkerOverrideOptions {
  /** AIdeation-Ordner auf dem Host (absolut). */
  installDir: string;
  /** DEV_LOG_PROJECT_ROOTS wie in der .env; leer = der Ordner, in dem AIdeation liegt (wie beim Worker auf dem Host). */
  projectRoots?: string;
  credentials?: WorkerCredentials;
  platform?: NodeJS.Platform;
}

/** Ziel der Git-Zugänge im Worker-Container. */
export const CREDENTIAL_TARGETS: Record<keyof WorkerCredentials, string> = {
  sshDir: `${WORKER_HOME}/.ssh`,
  ghConfigDir: `${WORKER_HOME}/.config/gh`,
  gitConfig: `${WORKER_HOME}/.gitconfig`,
  githubTokenFile: '/run/secrets/github_token',
};

/** Pfad im Worker-Container: auf macOS/Linux derselbe wie auf dem Host, unter Windows der von Docker Desktop. */
export function workerContainerPath(hostPath: string, platform: NodeJS.Platform = process.platform): string {
  return dockerHostPath((platform === 'win32' ? win32 : posix).normalize(hostPath), platform).replace(/(.)\/+$/, '$1');
}

/** YAML-Skalar: JSON-Zeichenketten sind gültige YAML-Zeichenketten in doppelten Anführungszeichen. */
const quote = (value: string): string => JSON.stringify(value);

function bind(source: string, target: string, readOnly: boolean): string[] {
  return [
    '      - type: bind',
    `        source: ${quote(source)}`,
    `        target: ${quote(target)}`,
    ...(readOnly ? ['        read_only: true'] : []),
  ];
}

/** Projektordner des Workers (Host-Pfade, ohne doppelte und ohne solche innerhalb eines anderen). */
export function workerRoots(installDir: string, roots: string | undefined, platform: NodeJS.Platform): string[] {
  const path = platform === 'win32' ? win32 : posix;
  const listed = projectRoots({ DEV_LOG_PROJECT_ROOTS: roots ?? '' });
  const all = listed.length ? listed : [path.dirname(path.resolve(installDir))];
  const key = (folder: string) => {
    const normalized = workerContainerPath(folder, platform);
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const inside = (child: string, parent: string) => child === parent || child.startsWith(`${parent}/`);
  return all.filter(
    (root, index) =>
      all.findIndex((other) => key(other) === key(root)) === index &&
      !all.some((other) => key(other) !== key(root) && inside(key(root), key(other))),
  );
}

/** Inhalt der docker-compose.override.yml. */
export function workerOverride(options: WorkerOverrideOptions): string {
  const platform = options.platform ?? process.platform;
  const install = workerContainerPath(options.installDir, platform);
  const roots = workerRoots(options.installDir, options.projectRoots, platform);
  const credentials = options.credentials ?? {};
  const credentialMounts = (Object.keys(CREDENTIAL_TARGETS) as (keyof WorkerCredentials)[]).flatMap((key) => {
    const source = credentials[key]?.trim();
    return source ? bind(source, CREDENTIAL_TARGETS[key], true) : [];
  });
  return [
    OVERRIDE_MARKER,
    '# Nicht von Hand ändern: start.sh bzw. start.cmd schreiben die Datei bei jedem Start neu (Quelle: .env).',
    '# AIdeation-Ordner und Projektordner mit demselben Pfad wie auf dem Host; Git-Zugänge nur im Worker, schreibgeschützt.',
    'services:',
    '  worker:',
    `    working_dir: ${quote(install)}`,
    '    environment:',
    `      DEV_LOG_INSTALL_DIR: ${quote(install)}`,
    `      DEV_LOG_PROJECT_ROOTS: ${quote(roots.map((root) => workerContainerPath(root, platform)).join(':'))}`,
    '    volumes:',
    ...bind(options.installDir, install, false),
    // Linux-Binärdateien statt der node_modules des Hosts (macOS/Windows).
    '      - type: volume',
    '        source: aideation_worker_modules',
    `        target: ${quote(`${install}/node_modules`)}`,
    ...roots.flatMap((root) => bind(root, workerContainerPath(root, platform), false)),
    ...credentialMounts,
    '  watchdog:',
    `    working_dir: ${quote(install)}`,
    '    environment:',
    `      DEV_LOG_INSTALL_DIR: ${quote(install)}`,
    '    volumes:',
    ...bind(options.installDir, install, true),
    '      - type: volume',
    '        source: aideation_worker_modules',
    `        target: ${quote(`${install}/node_modules`)}`,
    '        read_only: true',
    '',
  ].join('\n');
}

/**
 * Git-Zugänge aus der .env (DEV_LOG_WORKER_SSH_DIR, DEV_LOG_WORKER_GH_CONFIG_DIR, DEV_LOG_WORKER_GITCONFIG,
 * DEV_LOG_WORKER_GITHUB_TOKEN_FILE), sonst die üblichen Orte im Home – nur, was es auf dem Host gibt. Eine fehlende
 * Quelle legte Docker sonst als leeren Ordner (unter Linux als root) an.
 */
export function detectCredentials(
  env: Map<string, string>,
  home: string = homedir(),
  exists: (path: string) => boolean = existsSync,
): WorkerCredentials {
  const pick = (key: string, fallback: string): string | null => {
    const configured = env.get(key)?.trim();
    const path = configured || fallback;
    return exists(path) ? path : null;
  };
  return {
    sshDir: pick('DEV_LOG_WORKER_SSH_DIR', join(home, '.ssh')),
    ghConfigDir: pick('DEV_LOG_WORKER_GH_CONFIG_DIR', join(home, '.config', 'gh')),
    gitConfig: pick('DEV_LOG_WORKER_GITCONFIG', join(home, '.gitconfig')),
    githubTokenFile: pick('DEV_LOG_WORKER_GITHUB_TOKEN_FILE', join(home, '.config', 'aideation', 'github-token')),
  };
}

/**
 * Schreibt docker-compose.override.yml im AIdeation-Ordner aus dessen .env. „kept“: Es gibt schon eine eigene Datei
 * ohne Kennzeichnung – sie bleibt unverändert.
 */
export async function writeWorkerOverride(
  installDir: string,
  options: { home?: string; platform?: NodeJS.Platform } = {},
): Promise<'written' | 'unchanged' | 'kept'> {
  const file = join(installDir, OVERRIDE_FILE);
  const current = await readFile(file, 'utf8').catch(() => null);
  if (current !== null && !current.startsWith(OVERRIDE_MARKER)) return 'kept';
  const env = parseEnv(await readFile(join(installDir, '.env'), 'utf8').catch(() => ''));
  const content = workerOverride({
    installDir,
    projectRoots: env.get('DEV_LOG_PROJECT_ROOTS'),
    credentials: detectCredentials(env, options.home),
    platform: options.platform,
  });
  if (current === content) return 'unchanged';
  const temporary = join(dirname(file), `.${OVERRIDE_FILE}.tmp-${process.pid}`);
  await writeFile(temporary, content);
  await rename(temporary, file);
  return 'written';
}
