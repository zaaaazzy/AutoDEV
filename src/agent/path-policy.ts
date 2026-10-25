import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Gemeinsame Pfad-Richtlinie für beide Wächter: Claude-Agents (fileProblem in agent-guard.ts) und Datei-Werkzeuge des
 * lokalen Modells (resolveInside in tool-paths.ts). Eine Liste geschützter Pfade, eine Pfadauflösung.
 */

export const BACKUP_DIRECTORY = '.dev-log-backups';
/** Geheimnisse: .env*, Schlüssel und Zertifikate, SSH-Schlüssel sowie Zugangsdaten-Dateien (.npmrc-Tokens, .netrc …). */
export const SECRET_NAME = /^\.env|\.(?:pem|key)$|^id_(?:rsa|ed25519|ecdsa)|^\.(?:npmrc|netrc|git-credentials)$/i;
/** Ordner mit Schlüsseln und Zugangsdaten – gesperrt zum Schreiben und (im Claude-Wächter) auch zum Lesen. */
export const SECRET_DIRECTORIES = new Set(['.ssh', '.aws', '.gnupg']);

/**
 * Nie beschreibbare Ordner: Git samt Hooks (.git/hooks, .husky, .githooks), Agent-Einstellungen (.claude – sonst gäbe
 * sich ein Agent selbst Rechte oder hinterlegte einen Hook für den nächsten), Editor-Aufgaben (.vscode/tasks.json
 * startet Befehle), Abhängigkeiten (per .gitignore für Reviewer unsichtbar, laufen bei jedem Test mit) und Sicherungen.
 */
const PROTECTED_DIRECTORIES = new Set([
  '.git',
  '.husky',
  '.githooks',
  '.claude',
  '.vscode',
  'node_modules',
  BACKUP_DIRECTORY,
  ...SECRET_DIRECTORIES,
]);
/** Nie beschreibbare Dateien: .mcp.json sowie Einstellungen der Paketmanager (script-shell, node-options, Registry). */
const PROTECTED_FILE = /^(?:\.mcp\.json|\.npmrc|\.yarnrc.*|\.pnpmrc)$/i;

/** Ist ein Pfad (relativ zum Projekt) geschützt? Prüft jeden Pfadteil, unabhängig von Gross- und Kleinschreibung. */
export function protectedPath(rel: string): boolean {
  return rel
    .split(/[\\/]/)
    .filter(Boolean)
    .some((part) => PROTECTED_DIRECTORIES.has(part.toLowerCase()) || PROTECTED_FILE.test(part) || SECRET_NAME.test(part));
}

export const inside = (path: string, root: string): boolean => path === root || path.startsWith(root + sep);

/**
 * Pfad samt symbolischer Links auflösen (für noch nicht vorhandene Dateien über den nächsten vorhandenen Ordner).
 * null bei einem Link ins Leere: Schreiben legte sein (ungeprüftes) Ziel an, womöglich ausserhalb des Projekts.
 */
export function realTarget(path: string): string | null {
  let current = resolve(path);
  const rest: string[] = [];
  while (!existsSync(current) && dirname(current) !== current) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) return null;
    rest.unshift(basename(current));
    current = dirname(current);
  }
  return resolve(realpathSync(current), ...rest);
}

/** Wie realTarget, aber nie null und ohne Fehler (Prüfung „liegt im Projekt“ für Befehlsargumente): sonst der Pfad selbst. */
export function realPath(path: string): string {
  try {
    return realTarget(path) ?? resolve(path);
  } catch {
    return resolve(path);
  }
}

export type PathVerdict =
  | { ok: true; real: string; relative: string }
  | { ok: false; reason: 'dangling' }
  | { ok: false; reason: 'outside' }
  | { ok: false; reason: 'protected'; relative: string };

/**
 * Entscheidung für einen Schreibzugriff: Der Pfad muss samt aufgelöster Links im Projekt liegen, und weder der Pfad, wie
 * er dasteht (Link mit gesperrtem Namen), noch sein Ziel (Link auf einen gesperrten Ordner) darf geschützt sein.
 */
export function checkProjectPath(projectRoot: string, path: string): PathVerdict {
  const root = realpathSync(projectRoot);
  const lexical = resolve(root, path);
  const real = realTarget(lexical);
  if (!real) return { ok: false, reason: 'dangling' };
  if (!inside(real, root)) return { ok: false, reason: 'outside' };
  const rel = real.slice(root.length + 1);
  // Wie angegeben – relativ zum aufgelösten oder zum angegebenen Projektordner (z. B. /var vs. /private/var).
  const lexicalRels = [root, resolve(projectRoot)]
    .map((base) => relative(base, lexical))
    .filter((candidate) => !/^\.\.(?:[\\/]|$)/.test(candidate) && !isAbsolute(candidate));
  const hit = [rel, ...lexicalRels].find(protectedPath);
  return hit === undefined ? { ok: true, real, relative: rel } : { ok: false, reason: 'protected', relative: rel || hit };
}
