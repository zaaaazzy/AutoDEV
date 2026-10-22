// Prüfungen von Shell-Befehlen (npm, git, Assistenten-Dienste, eigene Regeln) für Wächter und lokales Modell.
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { parseShell, renderWords, type ShellWord } from './shell-parse.js';

/** Ein Befehl als Text oder – im Wächter – schon zerlegt (Wörter eines einfachen Befehls). */
type CommandInput = string | readonly ShellWord[];

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
  /^npm (?:ls|list|outdated|audit|doctor)(?: --(?:depth=\d|json|production|omit=dev|audit-level=[a-z]+))*$/,
  // Prüfbefehl der Routinen; Optionen und Pfade prüfen zusätzlich Wächter und gitPathProblem.
  /^git grep(?: (?:-[inlwcvEFIh]+|-e|--(?:line-number|ignore-case|count|files-with-matches|word-regexp|fixed-strings|extended-regexp|cached)|[\w@:./~^][\w@:./=~^-]*))*$/,
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
function prefixInside(word: ShellWord | undefined, root: string | undefined): boolean {
  const value = word?.text ?? '';
  if (!word || word.expanded || !value || value.startsWith('-') || value.startsWith('~') || value.includes('$'))
    return false;
  if (isAbsolute(value)) return false;
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
export function npmOptionProblem(input: CommandInput, root?: string): string | null {
  const words = toWords(input);
  const command = label(input);
  if (words[0]?.text !== 'npm') return null;
  for (let index = 1; index < words.length; index++) {
    const current = words[index];
    const word = current?.text ?? '';
    if (word === '--') break;
    if (!word.startsWith('-')) continue;
    const [flag = '', inline] = word.split(/=(.*)/s);
    // Wert direkt hinter „=“ oder als nächstes Wort.
    const prefixValue = (): ShellWord | undefined =>
      inline === undefined || !current ? words[++index] : { ...current, text: inline };
    if (disablesIgnoreScripts(flag.replace(/^-+/, ''), inline, words[index + 1]?.text)) {
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
  // git grep/ls-files würden sonst auch ignorierte Dateien (.env) durchsuchen.
  'no-exclude-standard',
];
/** Eigene Optionen, die zugleich Anfang einer gesperrten sind (git diff --text ≠ --textconv). */
const SAFE_GIT_OPTIONS = new Set(['text']);

/**
 * Gefährliche Option in einem git-Befehl? Git akzeptiert eindeutige Abkürzungen (--outp = --output, --upload-pa =
 * --upload-pack), darum ist jede lange Option gesperrt, deren Name der Anfang einer gesperrten ist. Dazu -c, -u und
 * -O (Pager bzw. Reihenfolge-Datei), auch in zusammengefassten Kurzoptionen (git grep -iOless). Anführungszeichen
 * und Backslashes werden wie in Bash entfernt.
 */
export function gitOptionProblem(command: CommandInput): boolean {
  const words = toWords(command).map((word) => word.text);
  if (words[0] !== 'git') return false;
  return words.slice(1).some((word) => {
    if (/^-[cu](?:=|$)/.test(word) || /^-[a-zA-Z]*O/.test(word)) return true;
    if (!word.startsWith('--') || word === '--') return false;
    const name = word.slice(2).split('=')[0] ?? '';
    return !SAFE_GIT_OPTIONS.has(name) && DANGEROUS_GIT_OPTIONS.some((option) => option.startsWith(name));
  });
}

/**
 * Pfadangaben von „git diff“: Liegt ein Pfad ausserhalb des Arbeitsbaums, schaltet Git von selbst in den
 * No-Index-Modus und gibt beliebige Dateien aus (git diff /dev/null ~/.zshrc). Darum muss jedes Argument – samt
 * aufgelöster Links – im Projekt liegen; Shell-Ersetzungen ($, ~) und Ordner-Dateien (-O) sind gesperrt.
 * Ohne Projektordner (root) sind absolute Pfade und „..“ gesperrt. Dasselbe gilt für „git grep“ und „git ls-files“
 * (Prüfbefehle der Routinen); bei git grep zusätzlich ohne Musterdatei (-f/--file), die ausserhalb liegen könnte.
 */
export function gitPathProblem(input: CommandInput, root?: string): string | null {
  // Umleitungen (2>/dev/null, 2>&1) trennt der Tokenizer ab; sie sind keine Argumente.
  const words = toWords(input);
  const command = label(input);
  const subcommand = words[1]?.text ?? '';
  if (words[0]?.text !== 'git' || !['diff', 'grep', 'ls-files'].includes(subcommand)) return null;
  for (const { text: word, expanded } of words.slice(2)) {
    if (/^(?:-O|--orderfile)/.test(word)) return `„${command}“: -O/--orderfile ist gesperrt.`;
    if (subcommand === 'grep' && /^(?:-[a-zA-Z]*f|--file(?:=|$))/.test(word)) {
      return `„${command}“: -f/--file ist gesperrt.`;
    }
    if (!word || word.startsWith('-')) continue;
    if (expanded || word.startsWith('~') || word.includes('$')) return `„${command}“: nur Pfade im Projektordner.`;
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
  // Genau ein einfacher Befehl ohne Umleitungen und ohne Werte, die erst die Shell zusammensetzt.
  const parsed = parseShell(command);
  const simple = parsed.ok && parsed.commands.length === 1 ? parsed.commands[0] : undefined;
  if (!simple || simple.redirects.length || simple.words.some((word) => word.expanded)) return false;
  if (npmOptionProblem(command, root) || gitPathProblem(command, root)) return false;
  if (COMMAND_PATTERN.test(command) || READ_COMMAND.test(command)) return true;
  const parts = command.split(/\s+/);
  if (parts[0] === 'npm' && ['install', 'i', 'uninstall'].includes(parts[1] ?? '') && parts.length > 2) {
    return parts.slice(2).every((part) => (part.startsWith('-') ? INSTALL_FLAGS.has(part) : PACKAGE_SPEC.test(part)));
  }
  return SAFE_COMMANDS.some((pattern) => pattern.test(command));
}

/** Pfad samt symbolischer Links auflösen; für noch nicht vorhandene Pfade über den nächsten vorhandenen Ordner. */
export function realPath(path: string): string {
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
const FORBIDDEN_COMMAND_NAMES =
  'sudo|su|doas|rm|rmdir|kill|killall|pkill|shutdown|reboot|halt|chmod|chown|chgrp|dd|mkfs\\S*|diskutil|security|crontab|osascript|open|curl|wget|ssh|scp|sftp|rsync|nc|ncat|telnet|sh|bash|zsh|fish|dash|eval|exec|source|env|xargs|python\\d*|perl|ruby|php|node|deno|bun|npx|pnpx|bunx|tsx|ts-node|launchctl|systemctl|service|brew|apt|apt-get|yum|dnf|pip\\d*|gem|cargo|go';
const FORBIDDEN_COMMANDS = new RegExp(`^(?:${FORBIDDEN_COMMAND_NAMES})\\b`);
/**
 * Befehle, die Dateien anlegen, ändern oder löschen. Die ersten sieben gibt die CLI mit --permission-mode acceptEdits
 * ohne Rückfrage und ohne --allowedTools-Regel frei – am Wächter vorbei an Rechten und Ordner-Einschränkung. Dateien
 * ändern Agents nur über die Datei-Werkzeuge; dazu Wrapper, die einen weiteren Befehl starten (command rm …).
 */
const FILE_COMMAND_NAMES =
  'mkdir|touch|rm|rmdir|mv|cp|sed|gsed|ln|tee|truncate|install|unlink|shred|patch|chflags|ditto|command|builtin|nohup|time|nice|timeout';
/** Gesperrte Befehle, die eingebaute Gruppen nur mit festem Präfix freigeben (node --check, npx --no-install …). */
const GUARD_PREFIXED = new Set(['node', 'npx', 'launchctl']);
const GUARD_FORBIDDEN = new RegExp(`^(?:${FORBIDDEN_COMMAND_NAMES}|${FILE_COMMAND_NAMES})$`);
/** find-Optionen, die löschen, Programme starten oder in Dateien schreiben. */
const FIND_WRITING = /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;

/**
 * Gesperrter Befehlsname in einem einfachen Befehl (für den Wächter, je Teilbefehl einer Kette): alle Befehle, die
 * keine Gruppe freigeben darf, und alle Datei-Befehle – auch mit Pfad (/bin/rm), in Anführungszeichen oder escapt.
 * Ein Befehlsname, den erst die Shell zusammensetzt ($X, r?, {rm,}), ist gesperrt (fail-closed).
 */
export function forbiddenCommand(command: CommandInput): boolean {
  const words = toWords(command);
  const first = words[0];
  if (!first) return false;
  const name = first.text;
  if (first.expanded || first.glob || /[$*?[\]{}~]/.test(name)) return true;
  const program = name.slice(name.lastIndexOf('/') + 1);
  if (program === 'find') return words.some((word) => FIND_WRITING.test(word.text));
  return GUARD_FORBIDDEN.test(program) && !(GUARD_PREFIXED.has(program) && program === name);
}
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
export function forbiddenSubcommand(command: CommandInput): boolean {
  // Bash entfernt Anführungszeichen und Backslashes: git "push", git pu\sh und npm 'install' sind dieselben Befehle.
  const tokens = toWords(command);
  const words = tokens.map((word) => word.text);
  const normalized = words.join(' ');
  if (FORBIDDEN_SUBCOMMANDS.test(normalized) || /^(?:git|docker|npm) -/.test(normalized)) return true;
  // „npm audit fix“ installiert und ändert package-lock.json – auch mit Optionen davor (npm audit --json fix).
  if (words[0] === 'npm' && words[1] === 'audit' && words.slice(2).includes('fix')) return true;
  // Befehlsname und Unterbefehl nur wörtlich: Variablen, Globs, Klammer-Erweiterung oder $'…' (git $X, git pus?,
  // git {push,}) setzt erst die Shell zusammen – und alle übrigen Prüfungen sähen den Befehl nicht.
  if (!CHECKED_PROGRAMS.has(words[0] ?? '')) return false;
  const literal = tokens.slice(0, words[0] === 'docker' && words[1] === 'compose' ? 3 : 2);
  return literal.some((word) => !/^[\w.:@/=+,-]+$/.test(word.raw));
}

/** Programme, deren Unterbefehle der Wächter prüft. */
export const CHECKED_PROGRAMS = new Set(['git', 'docker', 'docker-compose', 'npm', 'npx']);

/**
 * Zerlegt einen Befehl mit dem Tokenizer des Wächters (parseShell) in Wörter; Umleitungen gehören nicht dazu.
 * Lässt er sich nicht zerlegen (offenes Anführungszeichen, $(…) …), werden Anführungszeichen und Backslashes einfach
 * entfernt – sperren muss dann der Wächter selbst, die Prüfungen hier sehen so möglichst viele Wörter.
 */
function shellTokens(command: string): ShellWord[] {
  const parsed = parseShell(command);
  if (parsed.ok) return parsed.commands.flatMap((simple) => simple.words);
  return command
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => ({ text: raw.replace(/['"\\]/g, ''), raw, expanded: /[$~{}]/.test(raw), glob: /[*?[]/.test(raw) }));
}

const toWords = (command: CommandInput): readonly ShellWord[] =>
  typeof command === 'string' ? shellTokens(command) : command;
const label = (command: CommandInput): string => (typeof command === 'string' ? command : renderWords(command));

/** Zerlegt einen Befehl wie Bash in Wörter: Anführungszeichen und Backslashes entfernt, Leerzeichen darin trennen nicht. */
export function shellWords(command: string): string[] {
  return shellTokens(command).map((word) => word.text);
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
