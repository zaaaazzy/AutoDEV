import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMPOSE_STARTING,
  composeViolation,
  gitPathProblem,
  npmOptionProblem,
  SECRET_IN_COMMAND,
} from './tool-permissions.js';

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
}

export interface GuardInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

/** Ordnerangabe für die Einschränkung: relativ, ohne „..“ und ohne Shell-Sonderzeichen. */
export const SCOPE_PATTERN = /^(?!.*(?:^|\/)\.\.(?:\/|$))[\w@][\w@.+-]*(?:\/[\w@][\w@.+-]*)*$/;

/** Nie beschreibbar: Git-Interna, Agent-Einstellungen (sonst könnte sich ein Agent selbst Rechte geben) und Geheimnisse. */
const PROTECTED_PATH =
  /(?:^|\/)(?:\.git|\.claude|\.ssh|\.aws|\.gnupg)(?:\/|$)|(?:^|\/)(?:\.mcp\.json|\.env[^/]*|[^/]+\.(?:pem|key))$/i;

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Optionen, mit denen erlaubte Git-Befehle Programme starten oder Dateien schreiben würden. */
const DANGEROUS_GIT_OPTION =
  /(?:^|\s)(?:--upload-pack|--receive-pack|--exec|--output|--ext-diff|--textconv|--no-index|--config|-c|-u|--template|--separate-git-dir|--work-tree|--git-dir)(?:[=\s]|$)/;
/**
 * Shell-Konstrukte, die weitere Befehle verstecken oder im Hintergrund starten: Befehlsersetzung, Prozessersetzung,
 * Subshells und ein einzelnes „&“. Die CLI-Freigaben prüfen nur den Anfang; was dahinter steckt, sähe niemand.
 */
const SHELL_CONSTRUCT = /`|\$\(|[<>]\(|(?:^|[^&>|])&(?![&>])|&>(?!\s*\/dev\/null)|(?:^|[\s;&|])\(|\)(?:$|[\s;&|])/;
/** Paketangaben für npm install: nur Namen aus der Registry, keine Git-, Datei- oder URL-Quellen. */
const REGISTRY_SPEC = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+(?:@[\w.^~<>=*-]+)?$/i;
/** docker compose: Startbefehle nur in dieser Form – keine Compose-Datei, Umgebung oder Ordner von anderswo. */
const COMPOSE_START_FORMS = [
  /^docker compose up -d(?: --build| --wait| --force-recreate)*(?: [a-zA-Z0-9][\w.-]*)*$/,
  /^docker compose (?:start|restart|build)(?: [a-zA-Z0-9][\w.-]*)*$/,
];

/** Ausgabe in Dateien umleiten (ausser nach /dev/null bzw. 2>&1) – Schreiben läuft nur über die Datei-Werkzeuge. */
const FILE_REDIRECT = /(?:^|[^<>&\d])\d?>>?(?!&\d)(?!\s*\/dev\/null)/;

/** Pfad samt symbolischer Links auflösen (für noch nicht vorhandene Dateien über den nächsten vorhandenen Ordner). */
function realTarget(path: string): string {
  let current = path;
  const rest: string[] = [];
  while (!existsSync(current) && dirname(current) !== current) {
    rest.unshift(current.slice(dirname(current).length + 1));
    current = dirname(current);
  }
  return resolve(realpathSync(current), ...rest);
}

const inside = (path: string, root: string): boolean => path === root || path.startsWith(root + sep);

/** Entscheidung für einen Datei-Zugriff; liefert den Grund der Sperre oder null. */
export function fileProblem(input: GuardInput, policy: GuardPolicy, projectRoot: string): string | null {
  const raw = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (typeof raw !== 'string' || !raw) return 'Kein Dateipfad angegeben.';
  const root = realpathSync(projectRoot);
  const target = realTarget(isAbsolute(raw) ? raw : resolve(input.cwd ?? root, raw));
  if (!inside(target, root)) return `${raw} liegt ausserhalb des Projektordners.`;
  const relative = target.slice(root.length + 1);
  if (PROTECTED_PATH.test(relative)) return `${relative} ist geschützt (Git, Agent-Einstellungen oder Geheimnisse).`;
  if (policy.scopes.length && !policy.scopes.some((scope) => inside(target, resolve(root, scope)))) {
    return `${relative} liegt ausserhalb der erlaubten Ordner (${policy.scopes.join(', ')}).`;
  }
  const exists = existsSync(target);
  if (input.tool_name === 'Write' && !exists) {
    return policy.create ? null : 'Dateien anlegen ist für diesen Agent nicht freigegeben.';
  }
  return policy.edit ? null : 'Dateien ändern ist für diesen Agent nicht freigegeben.';
}

/** Entscheidung für einen Shell-Befehl (der Befehlsanfang ist bereits von der CLI freigegeben). */
export function bashProblem(command: string, projectRoot: string, run = spawnSync): string | null {
  if (SECRET_IN_COMMAND.test(command)) return 'Befehle mit Zugriff auf Geheimnisse (.env, Schlüssel) sind gesperrt.';
  if (FILE_REDIRECT.test(command.replace(/'[^']*'|"[^"]*"/g, ''))) {
    return 'Ausgabe in Dateien umleiten ist gesperrt – Dateien nur mit den Datei-Werkzeugen schreiben.';
  }
  const unquoted = command.replace(/'[^']*'|"[^"]*"/g, '');
  if (SHELL_CONSTRUCT.test(unquoted) || /\$\(|`/.test(command.replace(/'[^']*'/g, ''))) {
    return 'Befehlsersetzung, Subshells und Hintergrund-Befehle („$(…)“, Backticks, „(…)“, „&“) sind gesperrt – Befehle einzeln ausführen.';
  }
  const root = realpathSync(projectRoot);
  for (const part of command.split(/&&|\|\||[;|\n]/).map((entry) => entry.trim())) {
    if (/^[A-Za-z_]\w*=/.test(part) || /^(?:env|command|exec|builtin|nohup|time|sudo)\s/.test(part)) {
      return `„${part}“: Umgebungsvariablen vor dem Befehl und Wrapper-Befehle sind gesperrt.`;
    }
    if (/^git\s+-/.test(part)) return `„${part}“: Git-Optionen vor dem Unterbefehl (z. B. -C) sind gesperrt.`;
    if (/^git\s/.test(part) && DANGEROUS_GIT_OPTION.test(part)) {
      return `„${part}“: diese Git-Option ist gesperrt (startet Programme oder schreibt Dateien).`;
    }
    const gitProblem = gitPathProblem(part, root);
    if (gitProblem) return gitProblem;
    if (/^npm\s/.test(part)) {
      const npmProblem = npmOptionProblem(part, root);
      if (npmProblem) return npmProblem;
      const words = part.split(/\s+/);
      if (['install', 'i', 'add'].includes(words[1] ?? '')) {
        const specs = words.slice(2).filter((word) => !word.startsWith('-'));
        const foreign = specs.find((spec) => !REGISTRY_SPEC.test(spec));
        if (foreign) return `„${foreign}“: nur Pakete aus der npm-Registry, keine Git-, Datei- oder URL-Quellen.`;
      }
    }
    if (/^npx\s/.test(part) && !/^npx --no-install\s/.test(part)) {
      return 'npx nur mit --no-install (sonst lädt npx fremde Pakete aus dem Netz).';
    }
    if (/^docker(?:-compose|\s+compose)\s+-/.test(part)) {
      return `„${part}“: Optionen vor dem Compose-Befehl (-f, --project-directory, --env-file …) sind gesperrt.`;
    }
    if (/^docker-compose\s/.test(part)) return 'Bitte „docker compose“ (ohne Bindestrich) verwenden.';
    if (COMPOSE_STARTING.test(part) && !COMPOSE_START_FORMS.some((form) => form.test(part))) {
      return `„${part}“: erlaubt sind nur „docker compose up -d [--build] [--wait] [--force-recreate] [dienste]“ sowie start/restart/build [dienste].`;
    }
    if (COMPOSE_STARTING.test(part)) {
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
  if (WRITE_TOOLS.has(input.tool_name ?? '')) return fileProblem(input, policy, projectRoot);
  if (input.tool_name === 'Bash') {
    if (policy.shell === false) return 'Befehle sind für diesen Agent nicht freigegeben (nur lesen).';
    const command = input.tool_input?.command;
    return typeof command === 'string' ? bashProblem(command, projectRoot) : null;
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
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  let problem: string | null;
  try {
    problem = guardProblem(input, decodePolicy(process.argv[2]), root);
  } catch (error) {
    problem = `Prüfung fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (problem) {
    process.stderr.write(`AIdeation-Wächter: ${problem}\n`);
    process.exit(2);
  }
  process.exit(0);
}
