import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
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
  [SERVICES_COMMAND]:
    'Startet Live-Dienste der Projekte (launchd, ch.*) neu – nicht AIdeation selbst (com.aideation.*).',
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
    // Kein „git checkout“: Branch und Commits eines Auftrags verwaltet AIdeation; ein Checkout würde dem laufenden
    // Auftrag den Branch wechseln oder seine offenen Änderungen verwerfen.
    description: 'status, diff, log, fetch, pull --ff-only – kein Checkout, kein Push, kein Clone.',
    rules: prefixRules(['git status', 'git diff', 'git log', 'git fetch', 'git pull --ff-only']),
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
    description: 'Live-Dienste der Projekte (ch.*) per launchctl neu starten – nicht AIdeation selbst.',
    // Beim Start: Bash(launchctl kickstart -k gui/<uid>/ch.*) – Wildcard statt Präfix, weil „:*“ nur an Wortgrenzen greift.
    rules: [SERVICES_COMMAND],
  },
];

export const DEFAULT_PERMISSION_GROUPS = PERMISSION_GROUPS.map((group) => group.id);

/** Rollen mit erweiterten Rechten: Assistent, Entwickler, Tester (Tests, Coverage) und Reviewer (git diff). */
const TRUSTED_ROLES = new Set(['assistant', 'developer', 'tester', 'reviewer', 'routine']);
/**
 * Rollen mit Shell (unter dem Wächter), aber ohne Datei-Werkzeuge: zeitgesteuerte Routinen führen z. B. `npm audit`
 * aus, ändern aber nichts. Ergebnisse gehen nur über die Marker (@@BUG, @@IDEA, @@ORDER) weiter.
 */
export const NO_FILE_WRITE_ROLES = new Set(['routine']);
/**
 * Rollen, die nur lesen (Werkzeugumfang der Problemanalyse beim lokalen Modell): keine Datei-Werkzeuge, keine Shell –
 * auch nicht über eine eigene Zuweisung am Agent oder eigene Werkzeug-Regeln im Befehl.
 */
// pre_sprint: Agents „Vor dem Sprint“ planen und prüfen nur (ihre Änderungen würden sonst im ersten Auftrag landen).
export const READ_ONLY_ROLES = new Set(['visionary', 'analyst', 'pre_sprint']);
/** Rolle, deren (lesende) Rechte ein Agent bekommt, der vorübergehend nur lesen darf. */
export const READ_ONLY_PERMISSION_ROLE = 'analyst';

/** Ordner außerhalb des Projekts, die diese Rollen lesen dürfen (z. B. Dienst-Logs unter ~/Library/Logs). */
export function extraReadDirectories(environment: NodeJS.ProcessEnv = process.env): string[] {
  const home = environment.HOME;
  return home ? [`${home}/Library/Logs`] : [];
}

export const SECRET_IN_COMMAND =
  /\.env|\.pem\b|\.key\b|id_(?:rsa|ed25519|ecdsa)|\.ssh\b|\.aws\b|\.gnupg\b|\.netrc\b|\.npmrc\b|\.git-credentials\b/i;
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

/**
 * npm-Optionen, die Skripte mit einer anderen Shell starten, Einstellungen und Ablage ausserhalb lesen/schreiben oder
 * global installieren. npm akzeptiert eindeutige Abkürzungen (--scr = --script-shell), darum gilt jede Option als
 * gefährlich, deren Name der Anfang eines dieser Namen ist.
 */
const DANGEROUS_NPM_OPTIONS = [
  'script-shell',
  'userconfig',
  'globalconfig',
  'cache',
  'node-options',
  'global',
  'location',
  'shell',
  'call',
  'init-module',
  'editor',
  'git',
];
/** Kurzoptionen: -g (global), -L (location); -C (prefix) wird wie --prefix geprüft. */
const DANGEROUS_NPM_SHORT = /[gL]/;

/** --prefix bzw. -C: nur ein relativer Ordner im Projekt (samt aufgelöster Links), ohne Shell-Ersetzungen. */
function prefixInside(raw: string | undefined, root: string | undefined): boolean {
  const value = (raw ?? '').replace(/['"\\]/g, '');
  if (!value || value.startsWith('-') || value.startsWith('~') || value.includes('$') || isAbsolute(value))
    return false;
  if (!root) return RELATIVE_DIRECTORY.test(value);
  const real = realPath(resolve(root, value));
  return real === root || real.startsWith(root + sep);
}

/**
 * Schaltet die Option --ignore-scripts wieder ab? Bei npm gewinnt die letzte Angabe: --no-ignore-scripts,
 * --ignore-scripts=false oder „--ignore-scripts false“, auch abgekürzt (--ignore-s=false, --no-ig).
 */
function disablesIgnoreScripts(name: string, inline: string | undefined, next: string | undefined): boolean {
  if (name.startsWith('no-') && 'ignore-scripts'.startsWith(name.slice(3))) return true;
  if (!'ignore-scripts'.startsWith(name)) return false;
  return inline === undefined ? next === 'false' : inline !== 'true';
}

/**
 * Prüft die Optionen eines npm-Befehls (für Wächter und lokales Modell); liefert den Grund der Sperre oder null.
 * Ohne Projektordner (root) ist --prefix nur mit einem einfachen relativen Ordner erlaubt. Nach „--“ gehören die
 * Argumente dem Skript, nicht npm.
 */
export function npmOptionProblem(command: string, root?: string): string | null {
  const words = command.trim().split(/\s+/);
  if (words[0] !== 'npm') return null;
  for (let index = 1; index < words.length; index++) {
    const word = (words[index] ?? '').replace(/['"\\]/g, '');
    if (word === '--') break;
    if (!word.startsWith('-')) continue;
    const [flag = '', inline] = word.split(/=(.*)/s);
    const prefixValue = (): string | undefined => inline ?? words[++index];
    if (disablesIgnoreScripts(flag.replace(/^-+/, ''), inline, words[index + 1]?.replace(/['"\\]/g, ''))) {
      return `„${command}“: --ignore-scripts lässt sich nicht abschalten.`;
    }
    if (flag.startsWith('--')) {
      const name = flag.slice(2);
      if (name === 'prefix') {
        if (!prefixInside(prefixValue(), root)) return `„${command}“: --prefix nur für Ordner im Projekt.`;
      } else if (
        name &&
        ('prefix'.startsWith(name) || DANGEROUS_NPM_OPTIONS.some((option) => option.startsWith(name)))
      ) {
        return `„${command}“: diese npm-Option ist gesperrt.`;
      }
    } else if (flag === '-C') {
      if (!prefixInside(prefixValue(), root)) return `„${command}“: --prefix nur für Ordner im Projekt.`;
    } else if (flag.includes('C') || DANGEROUS_NPM_SHORT.test(flag)) {
      return `„${command}“: diese npm-Option ist gesperrt.`;
    }
  }
  return null;
}

/** Git-Optionen, mit denen erlaubte Befehle Programme starten oder Dateien schreiben würden (lange Form ohne „--“). */
const DANGEROUS_GIT_OPTIONS = [
  'upload-pack',
  'receive-pack',
  'exec',
  'output',
  'output-directory',
  'ext-diff',
  'textconv',
  'no-index',
  'config',
  'template',
  'separate-git-dir',
  'work-tree',
  'git-dir',
  'open-files-in-pager',
];
/** Eigene Optionen, die zugleich Anfang einer gesperrten sind (git diff --text ≠ --textconv). */
const SAFE_GIT_OPTIONS = new Set(['text']);

/**
 * Gefährliche Option in einem git-Befehl? Git akzeptiert eindeutige Abkürzungen (--outp = --output, --upload-pa =
 * --upload-pack), darum ist jede lange Option gesperrt, deren Name der Anfang einer gesperrten ist. Dazu -c, -u und
 * -O (Pager bzw. Reihenfolge-Datei). Anführungszeichen und Backslashes werden wie in Bash entfernt.
 */
export function gitOptionProblem(command: string): boolean {
  const words = shellWords(command);
  if (words[0] !== 'git') return false;
  return words.slice(1).some((word) => {
    if (/^-[cu](?:=|$)/.test(word) || word.startsWith('-O')) return true;
    if (!word.startsWith('--') || word === '--') return false;
    const name = word.slice(2).split('=')[0] ?? '';
    return !SAFE_GIT_OPTIONS.has(name) && DANGEROUS_GIT_OPTIONS.some((option) => option.startsWith(name));
  });
}

/**
 * Pfadangaben von „git diff“: Liegt ein Pfad ausserhalb des Arbeitsbaums, schaltet Git von selbst in den
 * No-Index-Modus und gibt beliebige Dateien aus (git diff /dev/null ~/.zshrc). Darum muss jedes Argument – samt
 * aufgelöster Links – im Projekt liegen; Shell-Ersetzungen ($, ~) und Ordner-Dateien (-O) sind gesperrt.
 * Ohne Projektordner (root) sind absolute Pfade und „..“ gesperrt.
 */
export function gitPathProblem(command: string, root?: string): string | null {
  // Umleitungen nach /dev/null bzw. 2>&1 sind keine Argumente (andere Umleitungen sperrt der Wächter vorher).
  const words = command
    .replace(/\d*>>?\s*(?:&\d+|\/dev\/null)/g, ' ')
    .trim()
    .split(/\s+/);
  if (words[0] !== 'git' || words[1] !== 'diff') return null;
  for (const raw of words.slice(2)) {
    const word = raw.replace(/['"\\]/g, '');
    if (/^(?:-O|--orderfile)/.test(word)) return `„${command}“: -O/--orderfile ist gesperrt.`;
    if (!word || word.startsWith('-')) continue;
    if (word.startsWith('~') || word.includes('$')) return `„${command}“: nur Pfade im Projektordner.`;
    const outside = root
      ? ((real) => real !== root && !real.startsWith(root + sep))(realPath(resolve(root, word)))
      : isAbsolute(word) || word.split('/').includes('..');
    if (outside) return `„${command}“: nur Pfade im Projektordner (Git liest sonst fremde Dateien).`;
  }
  return null;
}

/**
 * Allow safe fixed commands and validated package names/options for npm installs. Mit Projektordner (root) wird ein
 * --prefix samt symbolischer Links aufgelöst; ohne ist er nur als einfacher relativer Ordner erlaubt.
 */
export function isAllowedCommand(command: string, root?: string): boolean {
  if (npmOptionProblem(command, root) || gitPathProblem(command, root)) return false;
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
  let config: {
    services?: Record<string, Record<string, unknown>>;
    configs?: unknown;
    secrets?: unknown;
    volumes?: Record<string, unknown>;
  };
  try {
    config = JSON.parse(configJson.slice(configJson.indexOf('{'))) as typeof config;
  } catch {
    return 'Die Compose-Konfiguration konnte nicht geprüft werden (docker compose config liefert kein gültiges JSON).';
  }
  // Symbolische Links auflösen: ein Link im Projekt, der nach draussen zeigt, zählt als draussen.
  const inside = (path: unknown): boolean => {
    if (typeof path !== 'string' || !isAbsolute(path)) return false;
    const real = realPath(path);
    return real === root || real.startsWith(root + sep);
  };
  const isHostPath = (value: string): boolean => isAbsolute(value) || value.startsWith('.') || value.startsWith('~');
  const fileSources = (entries: unknown): unknown[] =>
    Object.values((entries ?? {}) as Record<string, { file?: unknown } | null>).map((entry) => entry?.file);
  for (const [name, service] of Object.entries(config.services ?? {})) {
    if (service.privileged === true) return `Dienst "${name}" ist privilegiert.`;
    const namespaces = [
      service.network_mode,
      service.pid,
      service.ipc,
      service.uts,
      service.userns_mode,
      service.cgroup,
    ];
    if (namespaces.some((value) => value === 'host' || (typeof value === 'string' && value.startsWith('container:')))) {
      return `Dienst "${name}" nutzt den Host-Namensraum oder den eines fremden Containers.`;
    }
    if (Array.isArray(service.cap_add) && service.cap_add.length)
      return `Dienst "${name}" fordert zusätzliche Capabilities an.`;
    if (Array.isArray(service.devices) && service.devices.length) return `Dienst "${name}" bindet Geräte ein.`;
    if (
      Array.isArray(service.security_opt) &&
      service.security_opt.some((option) => !String(option).startsWith('no-new-privileges'))
    )
      return `Dienst "${name}" lockert die Sicherheitsprofile (security_opt).`;
    if (
      Array.isArray(service.volumes_from) &&
      service.volumes_from.some((entry) => String(entry).startsWith('container:'))
    )
      return `Dienst "${name}" übernimmt Volumes eines fremden Containers.`;
    if (service.cgroup_parent !== undefined) return `Dienst "${name}" setzt cgroup_parent.`;
    const build =
      typeof service.build === 'string'
        ? { context: service.build }
        : (service.build as { context?: unknown; dockerfile?: unknown; additional_contexts?: unknown } | undefined);
    if (build) {
      if (build.context !== undefined && !inside(build.context))
        return `Build-Kontext von "${name}" liegt außerhalb des Projektordners.`;
      if (
        typeof build.dockerfile === 'string' &&
        typeof build.context === 'string' &&
        !inside(resolve(build.context, build.dockerfile))
      )
        return `Dockerfile von "${name}" liegt außerhalb des Projektordners.`;
      for (const extra of Object.values((build.additional_contexts ?? {}) as Record<string, unknown>)) {
        if (typeof extra === 'string' && isHostPath(extra) && !inside(extra))
          return `Zusätzlicher Build-Kontext von "${name}" liegt außerhalb des Projektordners.`;
      }
    }
    for (const volume of Array.isArray(service.volumes)
      ? (service.volumes as { type?: string; source?: unknown }[])
      : []) {
      if (volume.type === 'bind' && !inside(volume.source)) {
        return `Dienst "${name}" bindet ${String(volume.source)} außerhalb des Projektordners ein.`;
      }
    }
    const envFiles = Array.isArray(service.env_file) ? service.env_file : service.env_file ? [service.env_file] : [];
    for (const entry of envFiles) {
      const path = typeof entry === 'string' ? entry : (entry as { path?: unknown } | null)?.path;
      if (!inside(path)) return `Dienst "${name}" liest die env-Datei ${String(path)} außerhalb des Projektordners.`;
    }
  }
  for (const [kind, sources] of [
    ['Config', fileSources(config.configs)],
    ['Secret', fileSources(config.secrets)],
  ] as const) {
    for (const source of sources) {
      if (source !== undefined && !inside(source))
        return `${kind}-Datei ${String(source)} liegt außerhalb des Projektordners.`;
    }
  }
  for (const [name, volume] of Object.entries(config.volumes ?? {})) {
    const device = (volume as { driver_opts?: { device?: unknown } } | null)?.driver_opts?.device;
    if (typeof device === 'string' && isHostPath(device) && !inside(device))
      return `Volume "${name}" bindet ${device} außerhalb des Projektordners ein.`;
  }
  return null;
}

/** Pfad samt symbolischer Links auflösen; für noch nicht vorhandene Pfade über den nächsten vorhandenen Ordner. */
function realPath(path: string): string {
  let current = resolve(path);
  const rest: string[] = [];
  while (!existsSync(current) && dirname(current) !== current) {
    rest.unshift(basename(current));
    current = dirname(current);
  }
  try {
    return resolve(realpathSync(current), ...rest);
  } catch {
    return resolve(path);
  }
}

/** Gruppen-IDs eigener Gruppen: Kleinbuchstaben, Ziffern und Bindestriche. */
export const CUSTOM_GROUP_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;

/** Befehle, die keine Gruppe freigeben darf – auch keine selbst angelegte (Schutz von System, AIdeation und Daten). */
const FORBIDDEN_COMMANDS =
  /^(?:sudo|su|doas|rm|rmdir|kill|killall|pkill|shutdown|reboot|halt|chmod|chown|chgrp|dd|mkfs\S*|diskutil|security|crontab|osascript|open|curl|wget|ssh|scp|sftp|rsync|nc|ncat|telnet|sh|bash|zsh|fish|dash|eval|exec|source|env|xargs|python\d*|perl|ruby|php|node|deno|bun|npx|pnpx|bunx|tsx|ts-node|launchctl|systemctl|service|brew|apt|apt-get|yum|dnf|pip\d*|gem|cargo|go)\b/;
/** Unterbefehle, die keine Gruppe freigeben darf; der Wächter sperrt sie zusätzlich bei jedem Shell-Befehl. */
const FORBIDDEN_SUBCOMMAND_LIST = [
  ...[
    'push',
    'reset',
    'clean',
    'config',
    'remote',
    'rebase',
    'filter-branch',
    'update-ref',
    'gc',
    'clone',
    'submodule',
  ].map((sub) => `git ${sub}`),
  ...[
    'run',
    'exec',
    'create',
    'rm',
    'rmi',
    'system',
    'volume',
    'network',
    'image',
    'container',
    'cp',
    'login',
    'build',
    'buildx',
    'builder',
    'plugin',
    'context',
    'swarm',
    'service',
    'stack',
    'secret',
    'config',
    'commit',
    'export',
    'import',
    'load',
    'save',
    'update',
    'attach',
  ].map((sub) => `docker ${sub}`),
  ...['exec', 'run', 'cp', 'rm', 'attach'].map((sub) => `docker compose ${sub}`),
  ...[
    'publish',
    'unpublish',
    'deprecate',
    'dist-tag',
    'owner',
    'access',
    'exec',
    'x',
    'explore',
    'edit',
    'login',
    'adduser',
    'token',
    'config',
    'c',
    'set',
    'cache',
    '--prefix',
    '-C',
  ].map((sub) => `npm ${sub}`),
];
/** npm-Unterbefehle (samt Aliassen), die Installationsskripte ausführen – erlaubt nur direkt mit --ignore-scripts. */
const NPM_SCRIPT_SUBCOMMANDS = [
  ...['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add'],
  ...['ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean', 'install-test', 'it', 'install-ci-test', 'cit'],
  ...['update', 'up', 'upgrade', 'udpate', 'rebuild', 'rb', 'link', 'ln', 'dedupe', 'ddp'],
].map((sub) => `npm ${sub}`);
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FORBIDDEN_SUBCOMMANDS = new RegExp(
  `^(?:(?:${FORBIDDEN_SUBCOMMAND_LIST.map(escapeRegExp).join('|')})(?![\\w-])|(?:${NPM_SCRIPT_SUBCOMMANDS.map(escapeRegExp).join('|')})(?![\\w-])(?! --ignore-scripts(?:\\s|$)))`,
);

/**
 * Gesperrter Unterbefehl in einem Shell-Befehl (für den Wächter). Optionen vor dem Unterbefehl (git -C, docker -H,
 * npm --prefix) sind ebenfalls gesperrt, damit sie die Prüfung nicht umgehen.
 */
export function forbiddenSubcommand(command: string): boolean {
  // Bash entfernt Anführungszeichen und Backslashes: git "push", git pu\sh und npm 'install' sind dieselben Befehle.
  const words = shellWords(command);
  const normalized = words.join(' ');
  if (FORBIDDEN_SUBCOMMANDS.test(normalized) || /^(?:git|docker|npm) -/.test(normalized)) return true;
  // Befehlsname und Unterbefehl nur wörtlich: Variablen, Globs, Klammer-Erweiterung oder $'…' (git $X, git pus?,
  // git {push,}) setzt erst die Shell zusammen – und alle übrigen Prüfungen sähen den Befehl nicht.
  if (!CHECKED_PROGRAMS.has(words[0] ?? '')) return false;
  const raw = command.trim().split(/\s+/);
  const literal = raw.slice(0, words[0] === 'docker' && words[1] === 'compose' ? 3 : 2);
  return literal.some((word) => !/^[\w.:@/=+,-]+$/.test(word));
}

/** Programme, deren Unterbefehle der Wächter prüft. */
const CHECKED_PROGRAMS = new Set(['git', 'docker', 'docker-compose', 'npm', 'npx']);

/**
 * Zerlegt einen einfachen Shell-Befehl wie Bash in Wörter: Anführungszeichen und Backslashes werden entfernt,
 * Leerzeichen in Anführungszeichen trennen nicht. Bei einem offenen Anführungszeichen (der Wächter trennt Befehlsketten
 * auch innerhalb von Anführungszeichen) werden Anführungszeichen und Backslashes einfach entfernt.
 */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote = '';
  for (let index = 0; index < command.length; index++) {
    const char = command[index] ?? '';
    if (quote) {
      if (char === quote) quote = '';
      else if (quote === '"' && char === '\\' && /["\\$`]/.test(command[index + 1] ?? '')) word += command[++index];
      else word += char;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      started = true;
      if (char === "'" || char === '"') quote = char;
      else if (char === '\\') word += command[++index] ?? '';
      else word += char;
    }
  }
  if (quote)
    return command
      .replace(/['"\\]/g, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  if (started) words.push(word);
  return words;
}

/** Deckt ein Präfix (Regel „Bash(<präfix>:*)“) einen gesperrten Unterbefehl ab, z. B. „git“ oder „docker compose“? */
const coversForbidden = (prefix: string): boolean =>
  [...FORBIDDEN_SUBCOMMAND_LIST, ...NPM_SCRIPT_SUBCOMMANDS].some((forbidden) => forbidden.startsWith(`${prefix} `));
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
  if (FORBIDDEN_COMMANDS.test(command) || forbiddenSubcommand(command) || (match[2] && coversForbidden(command)))
    return `„${rule}“: dieser Befehl ist für Agents grundsätzlich gesperrt.`;
  if (
    /(?:^|[\s/])(?:\.env|\.ssh|\.aws|\.gnupg|com\.devlog|com\.aideation|DevLog|AIdeation)(?:[\s/]|$)/i.test(command) ||
    /\.\./.test(command)
  )
    return `„${rule}“: Zugriff auf Geheimnisse, AIdeation selbst oder übergeordnete Ordner ist gesperrt.`;
  return null;
}

/** Rechte eines Projekts: freigeschaltete Gruppen (null = alle) und eigene Gruppen dieses Projekts. */
export interface ProjectPermissions {
  enabled: string[] | null;
  custom: PermissionGroup[];
}

/** A database error fails the caller: without the project's choice every group would count as enabled. */
export async function loadProjectPermissions(
  pool: { query: <R>(sql: string, values: unknown[]) => Promise<{ rows: R[] }> },
  project: string,
): Promise<ProjectPermissions> {
  const [enabled, custom] = await Promise.all([
    pool
      .query<{ groups: string[] | null }>('SELECT agent_permissions AS groups FROM projects WHERE slug = $1', [project])
      .then((result) => result.rows[0]?.groups ?? null),
    pool
      .query<PermissionGroup>(
        'SELECT id, label, description, rules FROM project_permission_groups WHERE project_slug = $1 ORDER BY label',
        [project],
      )
      .then((result) => result.rows),
  ]);
  // Eigene Regeln werden beim Speichern geprüft (customRuleProblem). Ältere Zeilen aus der Zeit vor einer strengeren
  // Prüfung (z. B. „Bash(docker:*)“, das auch docker kill freigäbe) dürfen nicht weiter gelten: beim Laden aussortieren.
  const checked = custom.map((group) => ({
    ...group,
    rules: Array.isArray(group.rules) ? group.rules.filter((rule) => customRuleProblem(rule) === null) : group.rules,
  }));
  return { enabled, custom: checked };
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
  if (NO_FILE_WRITE_ROLES.has(role)) {
    return [...availableCommands(permissions)].filter((rule) => rule !== FILES_CREATE && rule !== FILES_EDIT);
  }
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

/** Rollen, denen der Admin per Befehl vollen Zugriff geben kann (ohne Wächter). */
export const FULL_ACCESS_ROLES = new Set(['assistant']);

/**
 * Verlangt der Befehl ausdrücklich alle Rechte (`--dangerously-skip-permissions` oder
 * `--permission-mode bypassPermissions`)? Gilt nur für Rollen in FULL_ACCESS_ROLES; alle anderen behalten den Wächter.
 */
export function hasFullAccess(command: readonly string[], role: string): boolean {
  if (!FULL_ACCESS_ROLES.has(role)) return false;
  return command.some(
    (part, index) =>
      part === '--dangerously-skip-permissions' ||
      part === '--permission-mode=bypassPermissions' ||
      (part === '--permission-mode' && command[index + 1] === 'bypassPermissions'),
  );
}

/**
 * Freigaben eines Agents: eigene Zuweisung, sonst der Projektstandard der Rolle – nur Befehle aus freigeschalteten
 * Projektgruppen; lesende Rollen bekommen nichts, Rollen ohne Dateirechte keine Datei-Regeln.
 */
function chosenRules(role: string, permissions: ProjectPermissions, agentCommands: string[] | null): string[] {
  if (READ_ONLY_ROLES.has(role)) return [];
  const noFileWrite = NO_FILE_WRITE_ROLES.has(role);
  const available = availableCommands(permissions);
  return normalizeCommands(agentCommands ?? roleDefaultCommands(role, permissions)).filter(
    (rule) =>
      (available.has(rule) || rule === FILES_CREATE || rule === FILES_EDIT) &&
      !(noFileWrite && (rule === FILES_CREATE || rule === FILES_EDIT)),
  );
}

/**
 * Rechte-Kontext für den eingebauten Ollama-Agent: dieselben Datei- und Befehlsrechte, die bei der Claude-CLI über
 * withAgentPermissions und den Wächter gelten.
 */
export function agentRights(
  role: string,
  permissions: ProjectPermissions,
  agentCommands: string[] | null,
  fileScopes: readonly string[] = [],
): { files: { create: boolean; edit: boolean; scopes: string[] }; commands: string[] } {
  const commands = chosenRules(role, permissions, agentCommands);
  return {
    files: { create: commands.includes(FILES_CREATE), edit: commands.includes(FILES_EDIT), scopes: [...fileScopes] },
    commands,
  };
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
  // Voller Zugriff nur für den Dashboard-Assistenten und nur, wenn der Admin ihn im Befehl ausdrücklich verlangt:
  // dann weder Wächter noch Sperrlisten – der Assistent arbeitet mit allen Rechten des Workers.
  if (hasFullAccess(command, role)) return command;
  const readOnly = READ_ONLY_ROLES.has(role);
  const noFileWrite = NO_FILE_WRITE_ROLES.has(role);
  const custom = !readOnly && !noFileWrite && rest.some((part) => /^--(?:allowed|disallowed)-?tools$/i.test(part));
  const chosen = chosenRules(role, permissions, agentCommands);
  // Selbst gesetzte Werkzeug-Regeln im Befehl bleiben (Entscheid des Admins); der Wächter prüft trotzdem.
  const policy = readOnly
    ? { create: false, edit: false, scopes: [], shell: false }
    : noFileWrite
      ? { create: false, edit: false, scopes: [] }
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
