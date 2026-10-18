import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const COMMAND_PATTERN =
  /^(?:npm (?:test|run [a-z0-9:_-]+)(?: [\w@:./=-]+)*|git (?:status|diff|log)(?: [\w@:./~^][\w@:./=~^-]*)*)$/;
const SERVICE_NAME = '[a-zA-Z0-9][\\w.-]*';
const ASSISTANT_SERVICE_PATTERNS = [
  new RegExp(`^docker compose (?:ps|config --services)$`),
  // Auch der Log-Scan des Produktions-Rückkanals: docker compose logs --since 15m --no-color <dienste>.
  new RegExp(`^docker compose logs(?: --since \\d+[smh])?(?: --no-color)?(?: --tail=\\d+)?(?: ${SERVICE_NAME})*$`),
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

/** Datei-Werkzeuge der Claude-CLI: Write legt an (oder überschreibt), die übrigen ändern bestehende Dateien. */
export const CREATE_TOOLS = ['Write'];
export const EDIT_TOOLS = ['Edit', 'NotebookEdit'];
export const FILE_TOOLS = [...CREATE_TOOLS, ...EDIT_TOOLS];
/** Befehle ohne Claude-Regel: Dateien anlegen bzw. ändern (Datei-Werkzeuge, vom Wächter geprüft) und Dienst-Logs lesen. */
export const FILES_CREATE = 'files:create';
export const FILES_EDIT = 'files:edit';
/** Frühere Sammelregel „Dateien erstellen und ändern“; wird beim Laden in beide Rechte aufgeteilt. */
export const LEGACY_FILES_COMMAND = 'files';
export const LOGS_COMMAND = 'logs';
/** SQL auf der Projekt-Datenbank – nur das lokale Modell hat dafür ein Werkzeug (run_sql). */
export const DATABASE_COMMAND = 'database';
/** Live-Dienste der Projekte neu starten; wird erst beim Start mit der Benutzer-ID des Workers aufgelöst. */
export const SERVICES_COMMAND = 'services';
const servicesRule = (): string => `Bash(launchctl kickstart -k gui/${process.getuid?.() ?? 501}/ch.*)`;
const PSEUDO_COMMANDS = new Set([FILES_CREATE, FILES_EDIT, LOGS_COMMAND, DATABASE_COMMAND, SERVICES_COMMAND]);

/** Ob eine Freigabe („Bash(befehl:*)“ bzw. „Bash(befehl)“) einen Shell-Befehl abdeckt (für das lokale Modell). */
export function rulesAllow(rules: readonly string[], command: string): boolean {
  return rules.some((rule) => {
    const bash = rule.match(/^Bash\((.+?)(:\*)?\)$/);
    if (!bash) return false;
    const prefix = bash[1]!;
    return bash[2] ? command === prefix || command.startsWith(`${prefix} `) : command === prefix;
  });
}
const isToolRule = (rule: string): boolean => !PSEUDO_COMMANDS.has(rule) && rule !== LEGACY_FILES_COMMAND;

/** Ersetzt frühere Regeln: „files“ durch Anlegen und Ändern, launchctl mit fester Benutzer-ID durch „services“. */
export function normalizeCommands(rules: readonly string[]): string[] {
  return [
    ...new Set(
      rules.flatMap((rule) =>
        rule === LEGACY_FILES_COMMAND
          ? [FILES_CREATE, FILES_EDIT]
          : /^Bash\(launchctl kickstart -k gui\/\d+\/ch\.\*\)$/.test(rule)
            ? [SERVICES_COMMAND]
            : [rule],
      ),
    ),
  ];
}

/** Lesbare Bezeichnung eines Befehls für die Oberfläche (ohne Platzhalter für weitere Argumente). */
export function commandLabel(rule: string): string {
  if (rule === FILES_CREATE) return 'Dateien anlegen';
  if (rule === FILES_EDIT) return 'Dateien ändern';
  if (rule === LOGS_COMMAND) return '~/Library/Logs lesen';
  if (rule === DATABASE_COMMAND) return 'SQL auf der Projekt-Datenbank';
  if (rule === SERVICES_COMMAND) return 'launchctl kickstart -k ch.*';
  const bash = rule.match(/^Bash\((.+?)(?::\*)?\)$/);
  if (bash) return bash[1]!.replace(/ gui\/\d+\//, ' ');
  const web = rule.match(/^WebFetch\(domain:(.+)\)$/);
  return web ? `Webseiten auf ${web[1]} abrufen` : rule;
}

/** Erklärung je Befehl (Hover in der Oberfläche). */
const COMMAND_HELP: Record<string, string> = {
  [FILES_CREATE]:
    'Neue Dateien im Projektordner (bzw. in den erlaubten Ordnern) anlegen. Bestehende Dateien überschreiben braucht zusätzlich „Dateien ändern“.',
  [FILES_EDIT]: 'Bestehende Dateien im Projektordner (bzw. in den erlaubten Ordnern) bearbeiten oder überschreiben.',
  [SERVICES_COMMAND]: 'Startet Live-Dienste der Projekte (launchd, ch.*) neu – nicht Dev Log selbst (com.devlog.*).',
  [DATABASE_COMMAND]:
    'Liest und ändert die Projekt-Datenbank per SQL (Werkzeug run_sql des lokalen Modells; braucht eine hinterlegte Datenbank-URL).',
  [LOGS_COMMAND]: 'Liest Dienst-Logs unter ~/Library/Logs, z. B. das Log des Live-Modus (nur lesen).',
  'Bash(lsof -i:*)': 'Zeigt, welche Prozesse welche Netzwerk-Ports belegen.',
  'Bash(ps:*)': 'Listet laufende Prozesse (nur lesen).',
  'Bash(netstat:*)': 'Zeigt offene Netzwerkverbindungen und Ports (nur lesen).',
  'Bash(node --version:*)': 'Zeigt die installierte Node.js-Version.',
  'Bash(launchctl list:*)': 'Listet die launchd-Dienste und ihren Status (nur lesen).',
  'WebFetch(domain:localhost)':
    'Ruft lokale Seiten und APIs auf localhost ab, z. B. um den laufenden Dienst zu prüfen.',
  'WebFetch(domain:127.0.0.1)': 'Ruft lokale Seiten und APIs auf 127.0.0.1 ab.',
  'Bash(npm test:*)': 'Führt die Tests des Projekts aus (Skript „test“ aus package.json).',
  'Bash(npm run:*)':
    'Führt ein Skript aus package.json aus, z. B. build oder lint. Achtung: Skripte können beliebige Befehle enthalten.',
  'Bash(npx --no-install ng:*)': 'Angular-CLI (ng build, ng test …) – nur die im Projekt installierte Version.',
  'Bash(npx --no-install tsc:*)': 'TypeScript-Prüfung bzw. -Übersetzung – nur die im Projekt installierte Version.',
  'Bash(npx --no-install vitest:*)': 'Vitest-Tests – nur die im Projekt installierte Version.',
  'Bash(npx --no-install playwright:*)': 'Playwright-Oberflächentests – nur die im Projekt installierte Version.',
  'Bash(node --check:*)': 'Prüft eine JavaScript-Datei nur auf Syntaxfehler, führt nichts aus.',
  'Bash(npm install --ignore-scripts:*)':
    'Installiert Abhängigkeiten aus package.json bzw. neue Pakete – ohne Installationsskripte.',
  'Bash(npm ci --ignore-scripts:*)':
    'Installiert exakt die Versionen aus package-lock.json – ohne Installationsskripte.',
  'Bash(git status:*)': 'Zeigt geänderte und neue Dateien im Repository.',
  'Bash(git diff:*)': 'Zeigt Änderungen zeilengenau (ohne --output, also ohne Dateien zu schreiben).',
  'Bash(git log:*)': 'Zeigt die Commit-Historie.',
  'Bash(git fetch:*)': 'Holt neue Commits vom Remote, ohne lokale Dateien zu ändern.',
  'Bash(git pull --ff-only:*)': 'Holt und übernimmt neue Commits, nur wenn kein Merge nötig ist.',
  'Bash(git checkout:*)':
    'Wechselt den Branch oder stellt Dateien aus Git wieder her (verwirft dort lokale Änderungen).',
  'Bash(docker compose ps:*)': 'Zeigt die Docker-Dienste des Projekts und ihren Status.',
  'Bash(docker compose config --services:*)': 'Listet die Namen der Docker-Dienste des Projekts.',
  'Bash(docker compose logs:*)': 'Zeigt die Logs der Docker-Dienste des Projekts.',
  'Bash(docker compose up:*)':
    'Startet die Docker-Dienste des Projekts. Vorher geprüft: nur Mounts und Builds im Projektordner, nicht privilegiert.',
  'Bash(docker compose stop:*)': 'Hält Docker-Dienste des Projekts an.',
  'Bash(docker compose start:*)': 'Startet angehaltene Docker-Dienste des Projekts (mit Compose-Prüfung).',
  'Bash(docker compose restart:*)': 'Startet Docker-Dienste des Projekts neu (mit Compose-Prüfung).',
  'Bash(docker compose down:*)': 'Stoppt und entfernt die Container des Projekts (Volumes bleiben erhalten).',
  'Bash(docker compose build:*)': 'Baut die Images der Docker-Dienste neu (mit Compose-Prüfung).',
  'Bash(docker compose pull:*)': 'Lädt neue Versionen der verwendeten Images.',
  'Bash(docker ps:*)': 'Listet alle laufenden Container (nur lesen).',
  'Bash(docker logs:*)': 'Zeigt die Logs eines Containers (nur lesen).',
};

/** Erklärung eines Befehls; für eigene Befehle eine allgemeine Beschreibung. */
export function commandHelp(rule: string): string {
  const known = COMMAND_HELP[rule];
  if (known) return known;
  const bash = rule.match(/^Bash\((.+?)(:\*)?\)$/);
  if (bash) return bash[2] ? `Führt „${bash[1]}“ aus, auch mit weiteren Argumenten.` : `Führt genau „${bash[1]}“ aus.`;
  return rule;
}

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    id: 'files',
    label: 'Dateien',
    description:
      'Dateien anlegen bzw. ändern, wahlweise nur in bestimmten Ordnern. Lesen und Durchsuchen ist immer erlaubt.',
    rules: [FILES_CREATE, FILES_EDIT],
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
    id: 'database',
    label: 'Projekt-Datenbank',
    description: 'SQL auf der Datenbank des Projekts (nur lokales Modell, sofern eine Datenbank-URL hinterlegt ist).',
    rules: [DATABASE_COMMAND],
  },
  {
    id: 'build',
    label: 'Build und Tests',
    description: 'npm-Skripte, Angular-, TypeScript- und Test-Werkzeuge ausführen.',
    rules: prefixRules([
      // Unterordner per „npm run --prefix <ordner> <skript>“. Kein „npm --prefix“: das erlaubte auch „npm --prefix . exec“.
      'npm test',
      'npm run',
      // Nur installierte Werkzeuge: „npx tsc“ lädt sonst das fremde npm-Paket „tsc“, „npx ng“ das Paket „ng“.
      // Kein „npx tsx“: startet beliebige Skripte.
      'npx --no-install ng',
      'npx --no-install tsc',
      'npx --no-install vitest',
      'npx --no-install playwright',
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
    // Kein „git clone“: mit -u/--upload-pack führt es beliebige Befehle aus und schreibt ausserhalb des Projekts.
    description: 'status, diff, log, fetch, pull --ff-only, checkout – kein Push, kein Clone.',
    rules: prefixRules(['git status', 'git diff', 'git log', 'git fetch', 'git pull --ff-only', 'git checkout']),
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
    // Beim Start: Bash(launchctl kickstart -k gui/<uid>/ch.*) – Wildcard statt Präfix, weil „:*“ nur an Wortgrenzen greift.
    rules: [SERVICES_COMMAND],
  },
];

export const DEFAULT_PERMISSION_GROUPS = PERMISSION_GROUPS.map((group) => group.id);

/** Rollen mit erweiterten Rechten: Assistent, Entwickler, Tester (Tests, Coverage) und Reviewer (git diff). */
const TRUSTED_ROLES = new Set(['assistant', 'developer', 'tester', 'reviewer']);
/**
 * Rollen, die nur lesen (Werkzeugumfang der Problemanalyse beim lokalen Modell): keine Datei-Werkzeuge, keine Shell –
 * auch nicht über eine eigene Zuweisung am Agent oder eigene Werkzeug-Regeln im Befehl.
 */
export const READ_ONLY_ROLES = new Set(['visionary']);

/** Ordner außerhalb des Projekts, die diese Rollen lesen dürfen (z. B. Dienst-Logs unter ~/Library/Logs). */
export function extraReadDirectories(environment: NodeJS.ProcessEnv = process.env): string[] {
  const home = environment.HOME;
  return home ? [`${home}/Library/Logs`] : [];
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
  /^(?:git (?:push|reset|clean|config|remote|rebase|filter-branch|update-ref|gc|clone|submodule)|docker (?:run|exec|rm|rmi|system|volume|network|image|container|cp|login)|docker compose (?:exec|run|cp|rm)|npm (?:publish|exec|x|login|adduser|token|config|cache|--prefix)|npm install(?! --ignore-scripts))\b/;
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
 * Legt für Agents ohne eigene Zuweisung (null) die Rollenstandards fest, damit die Oberfläche genau zeigt, was gilt.
 */
export async function materializeAgentCommands(
  pool: { query: <R>(sql: string, values: unknown[]) => Promise<{ rows: R[] }> },
  project: string,
): Promise<void> {
  const agents = (
    await pool.query<{ id: string; role: string }>(
      'SELECT id, role FROM agents WHERE project_slug = $1 AND allowed_commands IS NULL',
      [project],
    )
  ).rows;
  if (!agents.length) return;
  const permissions = await loadProjectPermissions(pool, project);
  for (const agent of agents) {
    await pool.query('UPDATE agents SET allowed_commands = $2 WHERE id = $1 AND allowed_commands IS NULL', [
      agent.id,
      roleDefaultCommands(agent.role, permissions),
    ]);
  }
}

/** Standardrechte einer Rolle, solange dem Agent keine Befehle einzeln zugewiesen sind (null). */
export function roleDefaultCommands(role: string, permissions: ProjectPermissions): string[] {
  if (READ_ONLY_ROLES.has(role)) return [];
  return TRUSTED_ROLES.has(role) ? [...availableCommands(permissions)] : [FILES_CREATE, FILES_EDIT];
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Hook-Befehl für den Wächter; null, wenn er nicht gestartet werden kann (dann gilt: nichts schreiben, keine Shell). */
export function guardHookCommand(policy: {
  create: boolean;
  edit: boolean;
  scopes: string[];
  shell?: boolean;
}): string | null {
  const typescript = import.meta.url.endsWith('.ts');
  const script = fileURLToPath(new URL(`./agent-guard.${typescript ? 'ts' : 'js'}`, import.meta.url));
  if (!existsSync(script)) return null;
  let loader: string[] = [];
  if (typescript) {
    try {
      // createRequire statt import.meta.resolve: funktioniert auch, wenn tsx das Modul als CommonJS lädt.
      loader = ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href];
    } catch {
      return null;
    }
  }
  const encoded = Buffer.from(JSON.stringify(policy)).toString('base64url');
  // Scheitert der Wächter selbst (Exit ≠ 0/2), sperrt „|| exit 2“ den Zugriff, statt ihn durchzulassen.
  return `${[process.execPath, ...loader, script, encoded].map(shellQuote).join(' ')} || exit 2`;
}

/**
 * Befehlszeile eines Agents mit seinen Rechten (nur Claude-CLI). Ohne eigene Zuweisung (null) gelten die
 * Rollenstandards. Jeder Agent bekommt genau die freigegebenen Befehle; Datei-Werkzeuge nur mit „Dateien anlegen“
 * bzw. „Dateien ändern“, und der Wächter (PreToolUse-Hook) prüft jeden Schreib- und Shell-Zugriff samt Ordnern.
 */
export function withAgentPermissions(
  command: string[],
  role: string,
  permissions: ProjectPermissions,
  agentCommands: string[] | null,
  fileScopes: readonly string[] = [],
  readDirectories: string[] = extraReadDirectories(),
): string[] {
  const [binary, ...rest] = command;
  const isClaude = binary !== undefined && binary.split(sep).pop() === 'claude';
  if (!isClaude) return command;
  const readOnly = READ_ONLY_ROLES.has(role);
  const custom = !readOnly && rest.some((part) => /^--(?:allowed|disallowed)-?tools$/i.test(part));
  const available = availableCommands(permissions);
  const chosen = readOnly
    ? []
    : normalizeCommands(agentCommands ?? roleDefaultCommands(role, permissions)).filter(
        (rule) => available.has(rule) || rule === FILES_CREATE || rule === FILES_EDIT,
      );
  // Selbst gesetzte Werkzeug-Regeln im Befehl bleiben (Entscheid des Admins); der Wächter prüft trotzdem.
  const policy = readOnly
    ? { create: false, edit: false, scopes: [], shell: false }
    : custom
      ? { create: true, edit: true, scopes: [] }
      : { create: chosen.includes(FILES_CREATE), edit: chosen.includes(FILES_EDIT), scopes: [...fileScopes] };
  const hook = guardHookCommand(policy);
  const blocked = [
    ...(policy.create && hook ? [] : CREATE_TOOLS),
    ...(policy.edit && hook ? [] : EDIT_TOOLS),
    ...(readOnly ? ['MultiEdit'] : []),
    ...(hook && !readOnly ? [] : ['Bash']),
  ];
  const guard = hook
    ? [
        '--settings',
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash',
                hooks: [{ type: 'command', command: hook, timeout: 90 }],
              },
            ],
          },
        }),
      ]
    : [];
  if (custom) return [binary, ...guard, ...(blocked.length ? ['--disallowedTools', blocked.join(',')] : []), ...rest];
  const rules = [...chosen.filter(isToolRule), ...(chosen.includes(SERVICES_COMMAND) ? [servicesRule()] : [])];
  const directories = chosen.includes(LOGS_COMMAND)
    ? readDirectories.flatMap((directory) => ['--add-dir', directory])
    : [];
  return [
    binary,
    ...directories,
    ...guard,
    ...(rules.length ? ['--allowedTools', rules.join(',')] : []),
    ...(blocked.length ? ['--disallowedTools', blocked.join(',')] : []),
    ...rest,
  ];
}
