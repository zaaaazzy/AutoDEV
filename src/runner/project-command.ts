import { basename, dirname } from 'node:path';
import { type CommandExecutor, type CommandResult, runCommand } from '../core/command.js';
import { GIT_GUARD_ENV } from '../core/git-guard.js';

/**
 * Docker-Compose-Projekt im Arbeitsordner der Agents (<Projekt>/agent bzw. <Ordner>-agents): eigener Name
 * (<projekt>-agent), damit „docker compose up/build“ der Agents nie die Live-Container des Projekts ersetzt – auch
 * wenn die Compose-Datei einen festen Namen setzt (die Umgebungsvariable hat Vorrang).
 */
export function agentComposeProject(cwd: string): string | null {
  const folder = basename(cwd);
  const project = folder === 'agent' ? basename(dirname(cwd)) : folder.endsWith('-agents') ? folder.slice(0, -7) : null;
  if (!project) return null;
  const name = project
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+/, '');
  return name ? `${name}-agent` : null;
}

/**
 * Projektcode (Tests, Build-Schritte, Coverage, Git mit seinen Hooks und Filtern) läuft nur mit einer Allowlist der
 * Umgebung des Workers. So sieht ein per Prompt-Injection geändertes `test`-Skript weder `DEV_LOG_SECRET_KEY` noch
 * `DEV_LOG_DATABASE_URL` noch andere Zugänge. Fehlt eine Variable, wird nicht auf `process.env` zurückgefallen.
 */
const ALLOWED_KEYS = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TERM',
  'COLORTERM',
  'FORCE_COLOR',
  'NO_COLOR',
  'TZ',
  'CI',
  'NODE_ENV',
  'NODE_EXTRA_CA_CERTS',
  'SSH_AUTH_SOCK',
  'DISPLAY',
  // Windows: ohne diese Variablen starten weder Shell noch Node.
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMDATA',
]);

/** Präfixe für Werkzeug-Einstellungen (Locale, npm, Playwright, Docker, nvm, macOS). */
const ALLOWED_PREFIXES = ['LC_', 'NPM_CONFIG_', 'PLAYWRIGHT_', 'DOCKER_', 'XDG_', 'NVM_', '__CF_'];

/** Auch innerhalb der Allowlist nie weitergeben (z. B. `npm_config__authToken`). */
const SECRET_KEY = /(?:^DEV_LOG_|PASSWORD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY|ACCESS_KEY|DATABASE_URL|CREDENTIAL)/i;

export function allowedProjectVariable(key: string): boolean {
  const upper = key.toUpperCase();
  if (SECRET_KEY.test(upper)) return false;
  return ALLOWED_KEYS.has(upper) || ALLOWED_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** Gefiltertes Environment für Projektcode; `cwd` setzt den eigenen Compose-Projektnamen der Agent-Ordner. */
export function projectEnvironment(
  cwd?: string,
  source: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(source).filter(([key, value]) => value !== undefined && allowedProjectVariable(key)),
  );
  const compose = cwd ? agentComposeProject(cwd) : null;
  return { ...env, ...(compose ? { COMPOSE_PROJECT_NAME: compose } : {}), ...extra };
}

/**
 * Git des Workers: gefiltertes Environment, keine Hooks (`core.hooksPath=/dev/null`) und kein fsmonitor-Befehl aus
 * der Repo-Konfiguration. Beides kann ein Agent im Projekt setzen; über GIT_CONFIG_* hat es Vorrang vor `.git/config`.
 * Alle übrigen ausführbaren Einträge (filter, credential.helper, include.path …) weist runCommand ab (core/git-guard.ts).
 * GitHub-Tokens bleiben erlaubt, damit Push über HTTPS funktioniert (die gh-Anmeldung ist ohnehin im Keyring lesbar).
 */
export function gitEnvironment(
  extra: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const tokens = Object.fromEntries(
    ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR'].flatMap((key) =>
      source[key] ? [[key, source[key]]] : [],
    ),
  );
  return {
    ...projectEnvironment(undefined, source),
    ...tokens,
    // runCommand prüft damit vor dem Aufruf die Repo-Konfiguration (filter, credential.helper, gitdir-Umlenkung).
    [GIT_GUARD_ENV]: '1',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'core.fsmonitor',
    GIT_CONFIG_VALUE_1: 'false',
    ...extra,
  };
}

type ProjectCommandOptions = Omit<NonNullable<Parameters<CommandExecutor>[2]>, 'env'> & {
  /** Zusätzliche Variablen (z. B. Git-Identität); ersetzen nie die Allowlist durch `process.env`. */
  extraEnv?: Record<string, string>;
};

/** Führt Projektcode immer mit dem gefilterten Environment aus. */
export function runProjectCommand(
  command: string[],
  cwd: string,
  options: ProjectCommandOptions = {},
  execute: CommandExecutor = runCommand,
): Promise<CommandResult> {
  const { extraEnv, ...rest } = options;
  return execute(command, cwd, { ...rest, env: projectEnvironment(cwd, process.env, extraEnv) });
}
