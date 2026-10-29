import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProjectPath, inside, realTarget, SECRET_DIRECTORIES } from './path-policy.js';
import { secretGlob, secretSegment } from './tool-paths.js';
import {
  COMPOSE_STARTING,
  composeViolation,
  forbiddenCommand,
  forbiddenSubcommand,
  gitFileProblem,
  gitOptionProblem,
  gitPathProblem,
  gitRemoteProblem,
  npmOptionProblem,
  SECRET_IN_COMMAND,
} from './tool-permissions.js';
import {
  CHECKED_PROGRAMS,
  type FileRights,
  SHELL_BUILTINS,
  unwrapCommand,
  WRAPPER_COMMANDS,
} from './command-checks.js';
import { parseShell, renderWords, type ShellRedirect, type ShellWord } from './shell-parse.js';

/**
 * Wächter für Claude-Agents (PreToolUse-Hook): prüft jeden Datei- und Shell-Zugriff, bevor die CLI ihn ausführt.
 * Die Freigaben der CLI (--allowedTools) prüfen nur den Befehlsanfang; der Wächter setzt durch, was sie nicht können:
 * Anlegen vs. Ändern, Ordner-Einschränkung, gesperrte Pfade und gefährliche Optionen erlaubter Befehle.
 */
export interface GuardPolicy {
  create: boolean;
  edit: boolean;
  /** Erlaubte Ordner relativ zum Projekt; leer = ganzes Projekt. */
  scopes: string[];
  /** false = keine Shell-Befehle (nur lesende Rollen wie der Visionär); fehlt die Angabe, gilt die CLI-Freigabe. */
  shell?: boolean;
  /** Projektordner, den AIdeation beim Start festlegt; geht vor CLAUDE_PROJECT_DIR und dem cwd der Eingabe. */
  root?: string;
}

export interface GuardInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

/** Ordnerangabe für die Einschränkung: relativ, ohne „..“ und ohne Shell-Sonderzeichen. */
export const SCOPE_PATTERN = /^(?!.*(?:^|\/)\.\.(?:\/|$))[\w@][\w@.+-]*(?:\/[\w@][\w@.+-]*)*$/;

/** npm-Unterbefehle (samt Aliassen), die Paketangaben installieren – nur Namen aus der Registry. */
const NPM_INSTALL_SUBCOMMANDS = new Set([
  ...['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add'],
  ...['update', 'up', 'upgrade', 'udpate'],
]);

/** Eingerichtete Git-Remotes des Projekts (git remote); origin gilt immer, ohne Abfrage nur origin. */
function gitRemotes(projectRoot: string, run: typeof spawnSync | null): string[] {
  const remotes = new Set(['origin']);
  const result = run?.('git', ['remote'], { cwd: projectRoot, encoding: 'utf8', timeout: 10_000 });
  if (result?.status === 0) {
    for (const name of String(result.stdout).split('\n')) {
      if (/^[\w][\w.-]*$/.test(name.trim())) remotes.add(name.trim());
    }
  }
  return [...remotes];
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead']);

/** Paketangaben für npm install: nur Namen aus der Registry, keine Git-, Datei- oder URL-Quellen. */
const REGISTRY_SPEC = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+(?:@[\w.^~<>=*-]+)?$/i;
/** docker compose: Startbefehle nur in dieser Form – keine Compose-Datei, Umgebung oder Ordner von anderswo. */
const COMPOSE_START_FORMS = [
  /^docker compose up -d(?: --build| --wait| --force-recreate)*(?: [a-zA-Z0-9][\w.-]*)*$/,
  /^docker compose (?:start|restart|build)(?: [a-zA-Z0-9][\w.-]*)*$/,
];

/** Wrapper und Präfixe, die einen weiteren Befehl starten – dessen Prüfung sähe sonst niemand. */
const WRAPPERS = new Set(['env', 'command', 'exec', 'builtin', 'nohup', 'time', 'sudo']);

/**
 * Schreibt die Umleitung in eine Datei? Erlaubt sind nur /dev/null, Lesen (<, <<<) und das Verdoppeln von
 * File-Deskriptoren (2>&1, >&-). Auch mehrstellige File-Deskriptoren (10>datei) und „<>“ (öffnet zum Lesen und
 * Schreiben, legt die Datei an) zählen – Schreiben läuft nur über die Datei-Werkzeuge.
 */
function writesFile({ operator, target }: ShellRedirect): boolean {
  const kind = operator.replace(/^\d+/, '');
  if (kind === '<' || kind === '<<<' || kind === '<&') return false;
  if (kind === '>&' && /^(?:\d+|-)$/.test(target.text) && !target.expanded) return false;
  return target.text !== '/dev/null' || target.expanded || target.glob;
}

/** Entscheidung für einen Datei-Zugriff; liefert den Grund der Sperre oder null. */
export function fileProblem(input: GuardInput, policy: GuardPolicy, projectRoot: string): string | null {
  const raw = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (typeof raw !== 'string' || !raw) return 'Kein Dateipfad angegeben.';
  const root = realpathSync(projectRoot);
  const verdict = checkProjectPath(projectRoot, isAbsolute(raw) ? raw : resolve(input.cwd ?? root, raw));
  if (!verdict.ok) {
    if (verdict.reason === 'dangling') return `${raw} ist ein symbolischer Link ins Leere.`;
    if (verdict.reason === 'outside') return `${raw} liegt ausserhalb des Projektordners.`;
    return `${verdict.relative} ist geschützt (Git, Hooks, Abhängigkeiten, Sicherungen, Einstellungen oder Geheimnisse).`;
  }
  const { real: target, relative } = verdict;
  if (policy.scopes.length && !policy.scopes.some((scope) => inside(target, resolve(root, scope)))) {
    return `${relative} liegt ausserhalb der erlaubten Ordner (${policy.scopes.join(', ')}).`;
  }
  const exists = existsSync(target);
  if (input.tool_name === 'Write' && !exists) {
    return policy.create ? null : 'Dateien anlegen ist für diesen Agent nicht freigegeben.';
  }
  return policy.edit ? null : 'Dateien ändern ist für diesen Agent nicht freigegeben.';
}

/** Relativer Pfad im Projekt: nicht absolut, ohne „..“-Segment, keine URL (data:, file: …). */
const projectRelativeFile = (path: string): boolean =>
  !!path && !isAbsolute(path) && !path.split(/[\\/]/).includes('..') && !/^[A-Za-z][\w+.-]*:/.test(path);

/** Nennt ein Pfadteil ein Geheimnis (SECRET_NAME) oder einen Schlüssel-Ordner? Auch Glob-Muster wie *.{pem,key}. */
const secretPart = (part: string): boolean => SECRET_DIRECTORIES.has(part.toLowerCase()) || secretSegment(part);

/** Pfad samt aufgelöster Links und „~“ – im Projekt relativ zum Projekt, sonst ganz – auf Geheimnisse prüfen. */
function secretPath(raw: string, cwd: string, root: string): boolean {
  const expanded = raw === '~' || raw.startsWith('~/') ? homedir() + raw.slice(1) : raw;
  const lexical = resolve(cwd, expanded);
  const candidates = [lexical];
  try {
    const real = realTarget(lexical);
    if (real) candidates.push(real);
  } catch {
    // Nicht auflösbar (z. B. keine Rechte): dann zählt der Pfad, wie er dasteht.
  }
  return candidates.some((path) =>
    (inside(path, root) ? path.slice(root.length) : path).split(/[\\/]/).filter(Boolean).some(secretPart),
  );
}

/**
 * Lesende Werkzeuge (Read, Grep, Glob): keine Geheimnisse wie .env, *.pem, *.key, SSH-Schlüssel – für jede Rolle,
 * unabhängig von der Richtlinie. Gemeldet wird nur der Pfad, nie ein Inhalt. Grep über einen ganzen Ordner prüft der
 * Wächter nicht Datei für Datei; dort greifen die Deny-Regeln der CLI (SECRET_READ_DENY).
 */
export function secretReadProblem(input: GuardInput, projectRoot: string): string | null {
  const root = realpathSync(projectRoot);
  const cwd = input.cwd ?? root;
  const tool = input.tool_input ?? {};
  const paths = [tool.file_path, tool.notebook_path, tool.path].filter(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  const patterns = [tool.glob, input.tool_name === 'Glob' ? tool.pattern : undefined].filter(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  const hit =
    paths.find((path) => secretPath(path, cwd, root)) ??
    patterns.find((pattern) => pattern.split(/[\\/]/).some(secretPart));
  return hit === undefined ? null : `${hit}: Geheimnisse (.env, Schlüssel, Zertifikate) sind für Agents gesperrt.`;
}

/** node --version oder node --check mit genau einer relativen Projektdatei (kein Optionswort, keine Shell-Erweiterung). */
function nodeCheckOnly(words: readonly ShellWord[]): boolean {
  const [, option, file] = words;
  if (words.length === 2) return option?.text === '--version';
  return (
    words.length === 3 &&
    option?.text === '--check' &&
    !!file &&
    !file.expanded &&
    !file.text.startsWith('-') &&
    projectRelativeFile(file.text)
  );
}

/**
 * Entscheidung für einen Shell-Befehl (der Befehlsanfang ist bereits von der CLI freigegeben). Gilt für Claude-Agents
 * und das lokale Modell gleichermassen. Der Befehl wird mit dem Tokenizer (parseShell) wie von Bash zerlegt; alle
 * Prüfungen sehen dieselben Wörter. Was sich nicht eindeutig zerlegen lässt, ist gesperrt. run = null: Compose-Starts
 * nicht selbst prüfen (das lokale Modell prüft sie asynchron unter der Projektsperre). files: Datei-Rechte für
 * git rm/mv (Löschen, Umbenennen); ohne sie sind beide gesperrt.
 */
export function bashProblem(
  command: string,
  projectRoot: string,
  run: typeof spawnSync | null = spawnSync,
  files?: FileRights,
): string | null {
  if (SECRET_IN_COMMAND.test(command)) return 'Befehle mit Zugriff auf Geheimnisse (.env, Schlüssel) sind gesperrt.';
  const parsed = parseShell(command);
  if (!parsed.ok) return parsed.problem;
  if (parsed.escapedQuote) {
    return 'Escapte Anführungszeichen (\\\' bzw. \\") sind gesperrt – Argumente einfach quoten.';
  }
  const root = realpathSync(projectRoot);
  // Je einfacher Befehl einer Kette (;, &&, ||, |, Zeilenumbruch), mit den Wörtern nach Bash-Quoting.
  for (const { words: written, redirects } of parsed.commands) {
    if (redirects.some(writesFile)) {
      return 'Ausgabe in Dateien umleiten ist gesperrt – Dateien nur mit den Datei-Werkzeugen schreiben.';
    }
    // timeout 60 git push: geprüft wird der Befehl hinter den Wrappern, als stünde er allein da.
    const words = unwrapCommand(written);
    if (!words) {
      return `„${renderWords(written)}“: Wrapper (${[...WRAPPER_COMMANDS].join(', ')}) nur mit einfachen Optionen und einem Befehl dahinter.`;
    }
    const part = renderWords(words);
    // Platzhalter treffen Geheimnisse, ohne den Namen zu nennen: cat .en? / cat .npm[r]c.
    if (words.some((word) => word.text.split('/').some(secretGlob))) {
      return 'Befehle mit Platzhaltern, die Geheimnisse (.env, Schlüssel) treffen, sind gesperrt.';
    }
    const [program = '', subcommand = '', third = ''] = words.map((word) => word.text);
    if (/^[A-Za-z_]\w*=/.test(program) || (WRAPPERS.has(program) && words.length > 1)) {
      return `„${part}“: Umgebungsvariablen vor dem Befehl und Wrapper-Befehle sind gesperrt.`;
    }
    if (SHELL_BUILTINS.has(program)) {
      return `„${part}“: Shell-Builtins wie cd, export, alias, source und eval sind gesperrt – jeden Befehl einzeln aufrufen.`;
    }
    // acceptEdits gibt mkdir, touch, rm, rmdir, mv, cp und sed ohne Regel frei – Rechte und Ordner prüft nur der Wächter.
    if (forbiddenCommand(words)) {
      return `„${part}“: dieser Befehl ist für Agents gesperrt – Dateien mit den Datei-Werkzeugen anlegen und ändern, mit „git rm <pfad>“ löschen und mit „git mv <alt> <neu>“ umbenennen.`;
    }
    if (program === 'git' && subcommand.startsWith('-')) {
      return `„${part}“: Git-Optionen vor dem Unterbefehl (z. B. -C) sind gesperrt.`;
    }
    if (gitOptionProblem(words)) {
      return `„${part}“: diese Git-Option ist gesperrt (startet Programme oder schreibt Dateien).`;
    }
    // Auch bei breiten eigenen Freigaben (Bash(git:*), Bash(docker:*)): diese Unterbefehle gibt keine Gruppe frei.
    if (forbiddenSubcommand(words)) return `„${part}“: dieser Befehl ist für Agents grundsätzlich gesperrt.`;
    // Variablen in Argumenten geprüfter Programme: X=--output=… lässt sich vorher mit export setzen.
    if (CHECKED_PROGRAMS.has(program) && words.some((word) => word.expanded)) {
      return `„${part}“: Variablen und Shell-Erweiterungen ($X, $'…', {a,b}, ~) sind in git-, npm- und docker-Befehlen gesperrt.`;
    }
    const gitProblem = gitPathProblem(words, root) ?? gitFileProblem(words, root, files);
    if (gitProblem) return gitProblem;
    if (program === 'git' && (subcommand === 'fetch' || subcommand === 'pull')) {
      const remoteProblem = gitRemoteProblem(words, gitRemotes(projectRoot, run));
      if (remoteProblem) return remoteProblem;
    }
    if (program === 'npm') {
      const npmProblem = npmOptionProblem(words, root);
      if (npmProblem) return npmProblem;
      if (NPM_INSTALL_SUBCOMMANDS.has(subcommand)) {
        const specs = words.slice(2).filter((word) => !word.text.startsWith('-'));
        const foreign = specs.find((spec) => !REGISTRY_SPEC.test(spec.text));
        if (foreign) return `„${foreign.text}“: nur Pakete aus der npm-Registry, keine Git-, Datei- oder URL-Quellen.`;
      }
    }
    if (program === 'npx' && (subcommand !== '--no-install' || words.length < 3)) {
      return 'npx nur mit --no-install (sonst lädt npx fremde Pakete aus dem Netz).';
    }
    // node lädt auch unter --check Module aus --import/-r und führt sie aus: nur genau diese zwei Formen.
    if (program === 'node' && !nodeCheckOnly(words)) {
      return `„${part}“: erlaubt sind nur „node --version“ und „node --check <relative Projektdatei>“ ohne weitere Optionen.`;
    }
    if (
      (program === 'docker-compose' && subcommand.startsWith('-')) ||
      (program === 'docker' && subcommand === 'compose' && third.startsWith('-'))
    ) {
      return `„${part}“: Optionen vor dem Compose-Befehl (-f, --project-directory, --env-file …) sind gesperrt.`;
    }
    if (program === 'docker-compose') return 'Bitte „docker compose“ (ohne Bindestrich) verwenden.';
    if (COMPOSE_STARTING.test(part) && !COMPOSE_START_FORMS.some((form) => form.test(part))) {
      return `„${part}“: erlaubt sind nur „docker compose up -d [--build] [--wait] [--force-recreate] [dienste]“ sowie start/restart/build [dienste].`;
    }
    if (COMPOSE_STARTING.test(part) && run) {
      const check = run('docker', ['compose', 'config', '--format', 'json'], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 60_000,
      });
      const reason =
        check.status === 0
          ? composeViolation(String(check.stdout), root)
          : `docker compose config schlug fehl: ${String(check.stderr).slice(-300)}`;
      if (reason) return `Start abgelehnt: ${reason} Nur Mounts und Builds im Projektordner, nicht privilegiert.`;
    }
  }
  return null;
}

/** Gesamtentscheidung für einen Hook-Aufruf. */
export function guardProblem(input: GuardInput, policy: GuardPolicy, projectRoot: string): string | null {
  if (READ_TOOLS.has(input.tool_name ?? '')) return secretReadProblem(input, projectRoot);
  if (WRITE_TOOLS.has(input.tool_name ?? '')) return fileProblem(input, policy, projectRoot);
  if (input.tool_name === 'Bash') {
    if (policy.shell === false) return 'Befehle sind für diesen Agent nicht freigegeben (nur lesen).';
    const command = input.tool_input?.command;
    return typeof command === 'string' ? bashProblem(command, projectRoot, spawnSync, policy) : null;
  }
  return null;
}

export const encodePolicy = (policy: GuardPolicy): string => Buffer.from(JSON.stringify(policy)).toString('base64url');

export function decodePolicy(value: string | undefined): GuardPolicy {
  // Ohne lesbare Richtlinie: nichts schreiben (sicherer Standard).
  try {
    const parsed = JSON.parse(Buffer.from(value ?? '', 'base64url').toString('utf8')) as Partial<GuardPolicy>;
    return {
      create: parsed.create === true,
      edit: parsed.edit === true,
      ...(parsed.shell === false ? { shell: false } : {}),
      ...(typeof parsed.root === 'string' && isAbsolute(parsed.root) ? { root: parsed.root } : {}),
      scopes: Array.isArray(parsed.scopes) ? parsed.scopes.filter((scope) => SCOPE_PATTERN.test(String(scope))) : [],
    };
  } catch {
    return { create: false, edit: false, scopes: [] };
  }
}

/** Pfad dieses Skripts und des tsx-Loaders, damit die CLI den Wächter unabhängig vom Projektordner startet. */
export const GUARD_SCRIPT = fileURLToPath(import.meta.url);

// Als Hook gestartet: Eingabe von stdin, Sperre mit Exit-Code 2 und Grund auf stderr (die CLI meldet ihn dem Agent).
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(GUARD_SCRIPT)) {
  let input: GuardInput = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8')) as GuardInput;
  } catch {
    process.stderr.write('AIdeation-Wächter: ungültige Eingabe.\n');
    process.exit(2);
  }
  const policy = decodePolicy(process.argv[2]);
  // Der Projektordner aus der Richtlinie: CLAUDE_PROJECT_DIR und cwd kann der Agent selbst beeinflussen (cd …).
  const root = policy.root || process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  let problem: string | null;
  try {
    problem = guardProblem(input, policy, root);
  } catch (error) {
    problem = `Prüfung fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (problem) {
    process.stderr.write(`AIdeation-Wächter: ${problem}\n`);
    process.exit(2);
  }
  process.exit(0);
}
