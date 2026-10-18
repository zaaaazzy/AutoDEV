import { sep } from 'node:path';

const COMMAND_PATTERN =
  /^(?:npm (?:test|run [a-z0-9:_-]+)(?: [\w@:./=-]+)*|git (?:status|diff|log)(?: [\w@:./~^][\w@:./=~^-]*)*)$/;
const SERVICE_NAME = '[a-zA-Z0-9][\\w.-]*';
const ASSISTANT_SERVICE_PATTERNS = [
  new RegExp(`^docker compose (?:ps|config --services)$`),
  new RegExp(`^docker compose logs(?: --tail=\\d+)?(?: ${SERVICE_NAME})*$`),
  new RegExp(`^docker compose up -d(?: --build| --wait| --force-recreate)*(?: ${SERVICE_NAME})*$`),
  new RegExp(`^docker compose (?:stop|start|restart|down|build|pull)(?: ${SERVICE_NAME})*$`),
  /^docker compose down --remove-orphans$/,
];
const GIT_URL = /^(?:https:\/\/[\w.-]+\/[\w./~-]+|git@[\w.-]+:[\w./~-]+)$/;
const RELATIVE_DIRECTORY = /^(?!.*\.\.)(?:\.|[\w][\w.-]*(?:\/[\w][\w.-]*)*)$/;

/** Allow the assistant to manage services and set up repositories within the project directory. */
export function isAssistantServiceCommand(command: string): boolean {
  if (ASSISTANT_SERVICE_PATTERNS.some((pattern) => pattern.test(command))) return true;
  const parts = command.split(/\s+/);
  if (parts[0] === 'git' && parts[1] === 'clone' && parts.length >= 3 && parts.length <= 4) {
    return GIT_URL.test(parts[2]) && (parts[3] === undefined || RELATIVE_DIRECTORY.test(parts[3]));
  }
  return /^git (?:pull --ff-only|fetch|checkout [\w][\w./-]*)$/.test(command);
}
/** Eine schaltbare Rechte-Gruppe für Dashboard-Assistent und Entwickler (Claude-CLI-Regeln). */
export interface PermissionGroup {
  id: string;
  label: string;
  description: string;
  rules: string[];
}

const prefixRules = (prefixes: string[]): string[] => prefixes.map((prefix) => `Bash(${prefix}:*)`);

/** Datei-Werkzeuge der Claude-CLI; ohne den Befehl „files“ werden sie dem Agent ausdrücklich verboten. */
export const FILE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
/** Befehle ohne Claude-Regel: Dateien schreiben (Datei-Werkzeuge) und Dienst-Logs lesen (Zusatzordner). */
export const FILES_COMMAND = 'files';
export const LOGS_COMMAND = 'logs';
const isToolRule = (rule: string): boolean => rule !== FILES_COMMAND && rule !== LOGS_COMMAND;

/** Lesbare Bezeichnung eines Befehls für die Oberfläche. */
export function commandLabel(rule: string): string {
  if (rule === FILES_COMMAND) return 'Dateien erstellen und ändern';
  if (rule === LOGS_COMMAND) return '~/Library/Logs lesen';
  const bash = rule.match(/^Bash\((.+?)(:\*)?\)$/);
  if (bash) return bash[2] ? `${bash[1]} …` : bash[1]!;
  const web = rule.match(/^WebFetch\(domain:(.+)\)$/);
  return web ? `Webseiten auf ${web[1]} abrufen` : rule;
}

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    id: 'files',
    label: 'Dateien',
    description: 'Dateien im Projektordner anlegen und bearbeiten (Lesen ist immer erlaubt).',
    rules: [FILES_COMMAND],
  },
  {
    id: 'diagnose',
    label: 'Diagnose',
    description:
      'Prozesse und Ports prüfen (ps, lsof, netstat), lokale URLs abrufen (WebFetch auf localhost). Dateien liest der Agent mit seinem Lese-Werkzeug, nicht per Shell.',
    rules: [
      ...prefixRules(['lsof -i', 'ps', 'netstat', 'node --version', 'launchctl list']),
      // Kein curl/cat/tail: Mit Shell-Lesebefehlen ließen sich Dateien außerhalb des Projekts lesen und per curl verschicken.
      'WebFetch(domain:localhost)',
      'WebFetch(domain:127.0.0.1)',
    ],
  },
  {
    id: 'logs',
    label: 'Dienst-Logs lesen',
    description: 'Zugriff auf ~/Library/Logs, z. B. das Log des Live-Modus.',
    rules: [LOGS_COMMAND],
  },
  {
    id: 'build',
    label: 'Build und Tests',
    description: 'npm-Skripte, Angular-, TypeScript- und Test-Werkzeuge ausführen.',
    rules: prefixRules([
      'npm test',
      'npm run',
      'npm --prefix',
      // Kein „npx --prefix“ und kein „npx tsx“: beides startet beliebige Pakete bzw. Skripte.
      'npx ng',
      'npx tsc',
      'npx vitest',
      'npx playwright',
      // Nur Syntaxprüfung, führt nichts aus.
      'node --check',
    ]),
  },
  {
    id: 'install',
    label: 'Pakete installieren',
    description:
      'Abhängigkeiten mit npm install bzw. npm ci installieren – immer mit --ignore-scripts (keine Installationsskripte).',
    rules: prefixRules(['npm install --ignore-scripts', 'npm ci --ignore-scripts']),
  },
  {
    id: 'git',
    label: 'Git lesen und aktualisieren',
    description: 'status, diff, log, fetch, pull --ff-only, checkout, clone – kein Push.',
    rules: prefixRules([
      'git status',
      'git diff',
      'git log',
      'git fetch',
      'git pull --ff-only',
      'git checkout',
      'git clone',
    ]),
  },
  {
    id: 'docker',
    label: 'Docker-Dienste',
    description: 'docker compose ps/logs/up/stop/start/restart/down/build/pull, docker ps und docker logs.',
    rules: prefixRules([
      'docker compose ps',
      'docker compose config --services',
      'docker compose logs',
      'docker compose up',
      'docker compose stop',
      'docker compose start',
      'docker compose restart',
      'docker compose down',
      'docker compose build',
      'docker compose pull',
      'docker ps',
      'docker logs',
    ]),
  },
  {
    id: 'services',
    label: 'Projekt-Dienste neu starten',
    description: 'Live-Dienste der Projekte (ch.*) per launchctl neu starten – nicht DevLog selbst.',
    // Wildcard statt Präfix, weil „:*“ nur an Wortgrenzen greift.
    rules: [`Bash(launchctl kickstart -k gui/${process.getuid?.() ?? 501}/ch.*)`],
  },
];

export const DEFAULT_PERMISSION_GROUPS = PERMISSION_GROUPS.map((group) => group.id);

/** Claude-Regeln der gewählten Gruppen (ohne Angabe: alle). */
export function permissionRules(groups: readonly string[] = DEFAULT_PERMISSION_GROUPS): string[] {
  return PERMISSION_GROUPS.filter((group) => groups.includes(group.id))
    .flatMap((group) => group.rules)
    .filter(isToolRule);
}

/** Rechte-Gruppen eines Projekts; ohne Einstellung gelten alle Standardgruppen. */
export async function loadPermissionGroups(
  pool: { query: <R>(sql: string, values: unknown[]) => Promise<{ rows: R[] }> },
  project: string,
): Promise<string[]> {
  const stored = (
    await pool
      .query<{ groups: string[] | null }>('SELECT agent_permissions AS groups FROM projects WHERE slug = $1', [project])
      .catch(() => ({ rows: [] as { groups: string[] | null }[] }))
  ).rows[0]?.groups;
  return stored ?? DEFAULT_PERMISSION_GROUPS;
}

/** Alle Regeln mit Standardrechten (für Tests und Doku). */
export const CLAUDE_ASSISTANT_TOOLS = permissionRules();

/** Rollen mit erweiterten Rechten: Assistent, Entwickler, Tester (Tests, Coverage) und Reviewer (git diff). */
const TRUSTED_ROLES = new Set(['assistant', 'developer', 'tester', 'reviewer']);

/** Ordner außerhalb des Projekts, die diese Rollen lesen dürfen (z. B. Dienst-Logs unter ~/Library/Logs). */
export function extraReadDirectories(environment: NodeJS.ProcessEnv = process.env): string[] {
  const home = environment.HOME;
  return home ? [`${home}/Library/Logs`] : [];
}

/** Gives the dashboard assistant and the developer their command rights when backed by the Claude Code CLI. */
export function withAssistantPermissions(
  command: string[],
  role: string,
  readDirectories: string[] = extraReadDirectories(),
  groups: readonly string[] = DEFAULT_PERMISSION_GROUPS,
): string[] {
  const [binary, ...rest] = command;
  const isClaude = binary !== undefined && binary.split(sep).pop() === 'claude';
  if (!TRUSTED_ROLES.has(role) || !isClaude || rest.some((part) => /^--allowed-?tools$/i.test(part))) return command;
  const directories = groups.includes('logs') ? readDirectories.flatMap((directory) => ['--add-dir', directory]) : [];
  const rules = permissionRules(groups);
  return [binary, ...directories, ...(rules.length ? ['--allowedTools', rules.join(',')] : []), ...rest];
}
export const SECRET_IN_COMMAND = /\.env|\.pem\b|\.key\b|id_(?:rsa|ed25519|ecdsa)/i;
const PACKAGE_SPEC = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+(?:@[\w.^~<>=*-]+)?$/i;
const INSTALL_FLAGS = new Set([
  '--save',
  '--save-dev',
  '-D',
  '--save-exact',
  '-E',
  '--legacy-peer-deps',
  '--no-audit',
  '--no-fund',
  '--ignore-scripts',
]);
const SAFE_COMMANDS = [
  /^npm (?:ls|list|outdated|audit|doctor)(?: --(?:depth=\d|json|production|omit=dev))*$/,
  /^npm (?:ci|install|i)(?: (?:--(?:legacy-peer-deps|no-audit|no-fund|ignore-scripts|omit=dev|production)|-[DE]))*$/,
  /^node (?:--version|--check [\w./-]+)$/,
  /^npx --no-install (?:tsc --noEmit|eslint [\w./*-]+|prettier --check [\w./*-]+|jest|vitest run)$/,
];

const READ_COMMAND =
  /^(?:git (?:status|log|diff|show|branch|remote -v|ls-files)(?: (?:--oneline|--stat|--graph|--decorate|--name-only|--name-status|--short|--all|-\d+|--max-count=\d+|[\w@:./~^][\w@:./=~^-]*))*|npm (?:ls|list|outdated)(?: --(?:depth=\d|json))*|node --version)$/;

const INSTALL_SUBCOMMANDS = new Set(['install', 'i', 'ci']);

/** npm-Installationen laufen immer ohne Installationsskripte (postinstall & Co. könnten beliebigen Code ausführen). */
export function withIgnoreScripts(parts: readonly string[]): string[] {
  if (parts[0] !== 'npm' || !INSTALL_SUBCOMMANDS.has(parts[1] ?? '') || parts.includes('--ignore-scripts')) {
    return [...parts];
  }
  return [...parts, '--ignore-scripts'];
}

/** Allow safe fixed commands and validated package names/options for npm installs. */
export function isAllowedCommand(command: string): boolean {
  if (COMMAND_PATTERN.test(command) || READ_COMMAND.test(command)) return true;
  const parts = command.split(/\s+/);
  if (parts[0] === 'npm' && ['install', 'i', 'uninstall'].includes(parts[1] ?? '') && parts.length > 2) {
    return parts.slice(2).every((part) => (part.startsWith('-') ? INSTALL_FLAGS.has(part) : PACKAGE_SPEC.test(part)));
  }
  return SAFE_COMMANDS.some((pattern) => pattern.test(command));
}

export const COMPOSE_STARTING = /^docker compose (?:up|start|restart|build)\b/;

/** Check the resolved Compose configuration for paths that escape the project directory. */
export function composeViolation(configJson: string, root: string): string | null {
  let config: { services?: Record<string, Record<string, unknown>> };
  try {
    config = JSON.parse(configJson.slice(configJson.indexOf('{'))) as typeof config;
  } catch {
    return 'Die Compose-Konfiguration konnte nicht geprüft werden (docker compose config liefert kein gültiges JSON).';
  }
  const inside = (path: unknown): boolean => typeof path === 'string' && (path === root || path.startsWith(root + sep));
  for (const [name, service] of Object.entries(config.services ?? {})) {
    if (service.privileged === true) return `Dienst "${name}" ist privilegiert.`;
    if (
      ['host'].includes(String(service.network_mode)) ||
      service.pid === 'host' ||
      service.ipc === 'host' ||
      service.userns_mode === 'host'
    ) {
      return `Dienst "${name}" nutzt den Host-Namensraum.`;
    }
    if (Array.isArray(service.cap_add) && service.cap_add.length)
      return `Dienst "${name}" fordert zusätzliche Capabilities an.`;
    if (Array.isArray(service.devices) && service.devices.length) return `Dienst "${name}" bindet Geräte ein.`;
    const build = service.build;
    const context = typeof build === 'string' ? build : (build as { context?: unknown } | undefined)?.context;
    if (context !== undefined && !inside(context))
      return `Build-Kontext von "${name}" liegt außerhalb des Projektordners.`;
    for (const volume of Array.isArray(service.volumes)
      ? (service.volumes as { type?: string; source?: unknown }[])
      : []) {
      if (volume.type === 'bind' && !inside(volume.source)) {
        return `Dienst "${name}" bindet ${String(volume.source)} außerhalb des Projektordners ein.`;
      }
    }
  }
  return null;
}

/** Gruppen-IDs eigener Gruppen: Kleinbuchstaben, Ziffern und Bindestriche. */
export const CUSTOM_GROUP_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;

/** Befehle, die keine Gruppe freigeben darf – auch keine selbst angelegte (Schutz von System, Dev Log und Daten). */
const FORBIDDEN_COMMANDS =
  /^(?:sudo|su|doas|rm|rmdir|kill|killall|pkill|shutdown|reboot|halt|chmod|chown|chgrp|dd|mkfs\S*|diskutil|security|crontab|osascript|open|curl|wget|ssh|scp|sftp|rsync|nc|ncat|telnet|sh|bash|zsh|fish|dash|eval|exec|source|env|xargs|python\d*|perl|ruby|php|node|deno|bun|npx|pnpx|bunx|tsx|ts-node|launchctl|systemctl|service|brew|apt|apt-get|yum|dnf|pip\d*|gem|cargo|go)\b/;
const FORBIDDEN_SUBCOMMANDS =
  /^(?:git (?:push|reset|clean|config|remote|rebase|filter-branch|update-ref|gc)|docker (?:run|exec|rm|rmi|system|volume|network|image|container|cp|login)|docker compose (?:exec|run|cp|rm)|npm (?:publish|exec|x|login|adduser|token|config|cache)|npm install(?! --ignore-scripts))\b/;
const SAFE_PREFIX = /^[\w@./=:,+-]+(?: [\w@./=:,+-]+)*$/;

/**
 * Prüft eine Regel einer eigenen Gruppe. Erlaubt sind nur „Bash(<Befehl>:*)“ bzw. „Bash(<Befehl>)“ ohne
 * Shell-Sonderzeichen und ohne gesperrte Befehle sowie WebFetch auf localhost. Liefert die Fehlermeldung oder null.
 */
export function customRuleProblem(rule: string): string | null {
  const web = /^WebFetch\(domain:(?:localhost|127\.0\.0\.1)\)$/.test(rule);
  if (web) return null;
  const match = rule.match(/^Bash\((.+?)(:\*)?\)$/);
  if (!match) return `„${rule}“: erlaubt sind Bash(befehl:*), Bash(befehl) oder WebFetch(domain:localhost).`;
  const command = match[1]!.trim();
  if (!SAFE_PREFIX.test(command))
    return `„${rule}“: keine Shell-Sonderzeichen (; & | $ \` > < * ? Klammern, Anführungszeichen).`;
  if (command.length > 120) return `„${rule}“: Befehl zu lang.`;
  if (FORBIDDEN_COMMANDS.test(command) || FORBIDDEN_SUBCOMMANDS.test(command))
    return `„${rule}“: dieser Befehl ist für Agents grundsätzlich gesperrt.`;
  if (/(?:^|[\s/])(?:\.env|\.ssh|\.aws|\.gnupg|com\.devlog|DevLog)(?:[\s/]|$)/i.test(command) || /\.\./.test(command))
    return `„${rule}“: Zugriff auf Geheimnisse, Dev Log selbst oder übergeordnete Ordner ist gesperrt.`;
  return null;
}

/** Rechte eines Projekts: freigeschaltete Gruppen (null = alle) und eigene Gruppen dieses Projekts. */
export interface ProjectPermissions {
  enabled: string[] | null;
  custom: PermissionGroup[];
}

export async function loadProjectPermissions(
  pool: { query: <R>(sql: string, values: unknown[]) => Promise<{ rows: R[] }> },
  project: string,
): Promise<ProjectPermissions> {
  const [enabled, custom] = await Promise.all([
    pool
      .query<{ groups: string[] | null }>('SELECT agent_permissions AS groups FROM projects WHERE slug = $1', [project])
      .then((result) => result.rows[0]?.groups ?? null)
      .catch(() => null),
    pool
      .query<PermissionGroup>(
        'SELECT id, label, description, rules FROM project_permission_groups WHERE project_slug = $1 ORDER BY label',
        [project],
      )
      .then((result) => result.rows)
      .catch(() => [] as PermissionGroup[]),
  ]);
  return { enabled, custom };
}

/** Gruppen, die in einem Projekt zur Verfügung stehen: eingebaute (freigeschaltet) und eigene; „files“ immer. */
export function availableGroups(permissions: ProjectPermissions): PermissionGroup[] {
  const all = [...PERMISSION_GROUPS, ...permissions.custom];
  return permissions.enabled
    ? all.filter(
        (group) =>
          group.id === 'files' || permissions.enabled!.includes(group.id) || permissions.custom.includes(group),
      )
    : all;
}

/** Alle Befehle, die einem Agent in diesem Projekt zugewiesen werden können (je Kategorie). */
export function availableCommands(permissions: ProjectPermissions): Set<string> {
  return new Set(availableGroups(permissions).flatMap((group) => group.rules));
}

/**
 * Befehlszeile eines Agents mit seinen Rechten (nur Claude-CLI). Ohne eigene Zuweisung (null) gilt das bisherige
 * Verhalten: Assistent, Entwickler, Tester und Reviewer bekommen die Projektkategorien. Mit Zuweisung bekommt jeder
 * Agent genau die einzeln gesetzten Befehle – und ohne „Dateien erstellen und ändern“ keine Datei-Werkzeuge.
 */
export function withAgentPermissions(
  command: string[],
  role: string,
  permissions: ProjectPermissions,
  agentCommands: string[] | null,
  readDirectories: string[] = extraReadDirectories(),
): string[] {
  const [binary, ...rest] = command;
  const isClaude = binary !== undefined && binary.split(sep).pop() === 'claude';
  if (!isClaude || rest.some((part) => /^--(?:allowed|disallowed)-?tools$/i.test(part))) return command;
  if (agentCommands === null && !TRUSTED_ROLES.has(role)) return command;
  const available = availableCommands(permissions);
  const chosen =
    agentCommands === null ? [...available] : [...new Set(agentCommands)].filter((rule) => available.has(rule));
  const rules = chosen.filter(isToolRule);
  const directories = chosen.includes(LOGS_COMMAND)
    ? readDirectories.flatMap((directory) => ['--add-dir', directory])
    : [];
  const denied =
    agentCommands !== null && !chosen.includes(FILES_COMMAND) ? ['--disallowedTools', FILE_TOOLS.join(',')] : [];
  return [binary, ...directories, ...(rules.length ? ['--allowedTools', rules.join(',')] : []), ...denied, ...rest];
}
