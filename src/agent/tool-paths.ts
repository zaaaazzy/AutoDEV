import { randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { BACKUP_DIRECTORY, checkProjectPath, SECRET_NAME } from './path-policy.js';

export { BACKUP_DIRECTORY, SECRET_NAME } from './path-policy.js';
/** Beim Auflisten und Durchsuchen übersprungen (nicht dasselbe wie geschützt: dist und coverage bleiben beschreibbar). */
export const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  '.angular',
  BACKUP_DIRECTORY,
  '.cache',
  'coverage',
]);
export const MAX_FILE_BYTES = 400_000;

/** Beispielnamen: ein Glob-Segment, das einen davon trifft, kann ein Geheimnis lesen (.en? trifft .env). */
const SECRET_SAMPLES = [
  '.env',
  '.env.local',
  'a.pem',
  'a.key',
  'id_rsa',
  'id_ed25519',
  '.npmrc',
  '.netrc',
  '.git-credentials',
];
/** Gewöhnliche Namen: trifft das Segment auch einen davon (z. B. `*`, `*.md`), ist es kein gezielter Zugriff auf Geheimnisse. */
const NEUTRAL_SAMPLES = ['x', 'index', 'a.ts', 'a.md', 'a.json'];

/** Glob-Segment (*, ?, [..]) als Regex; null ohne Platzhalter oder bei ungültigem Muster. */
function globRegex(part: string): RegExp | null {
  if (!/[*?[]/.test(part)) return null;
  const source = part
    .replace(/[.+^$()|\\{}]/g, '\\$&')
    .replace(/\*+/g, '.*')
    .replace(/\?/g, '.');
  try {
    return new RegExp(`^${source}$`, 'i');
  } catch {
    return null;
  }
}

/** Zielt ein Segment mit Platzhaltern auf Geheimnisse (`.en?`, `.e[n]v`, `*.pe?`)? `*` allein bleibt erlaubt. */
export function secretGlob(part: string): boolean {
  const regex = globRegex(part);
  return (
    !!regex && SECRET_SAMPLES.some((name) => regex.test(name)) && !NEUTRAL_SAMPLES.some((name) => regex.test(name))
  );
}

/** Klammern wie `.{e,x}nv` zu allen Fassungen auflösen (verschachtelt, höchstens 64). */
export function expandBraces(part: string): string[] {
  const match = /^(.*?)\{([^{}]*)\}(.*)$/s.exec(part);
  if (!match) return [part];
  const [, head, body, tail] = match;
  return body
    .split(',')
    .flatMap((alternative) => expandBraces(head + alternative + tail))
    .slice(0, 64);
}

/** Ist das Segment (samt Klammern und Platzhaltern) ein Geheimnis? */
export const secretSegment = (part: string): boolean =>
  expandBraces(part).some((name) => SECRET_NAME.test(name) || secretGlob(name));

export class ToolError extends Error {}

/**
 * Pfad für die Datei-Werkzeuge des lokalen Modells: im Projekt (samt aufgelöster Links) und nicht geschützt – dieselbe
 * Richtlinie wie im Claude-Wächter (checkProjectPath). Lesen verlangt eine vorhandene Datei.
 */
export async function resolveInside(cwd: string, requested: unknown, forWrite = false): Promise<string> {
  if (typeof requested !== 'string' || !requested || requested.includes('\0')) {
    throw new ToolError('Ungültiger Pfad.');
  }
  const root = await realpath(cwd);
  const target = resolve(root, requested);
  checkedPath(root, target);
  if (!forWrite && !existsSync(target)) {
    throw new ToolError('Pfad existiert nicht.');
  }
  return target;
}

/** Wirklicher Pfad (samt Links) im Projekt und nicht geschützt, sonst ToolError. */
function checkedPath(root: string, target: string): string {
  const verdict = checkProjectPath(root, target);
  if (!verdict.ok) {
    throw new ToolError(
      verdict.reason === 'outside'
        ? 'Pfad liegt außerhalb des Projektverzeichnisses.'
        : 'Zugriff auf diesen Pfad ist nicht erlaubt.',
    );
  }
  return verdict.real;
}

/**
 * Schreibt eine Datei im Projekt, ohne dass ein inzwischen gesetzter Link den Schreibvorgang umlenkt: Erst nach dem
 * Anlegen der Ordner wird der wirkliche Pfad (realpath) geprüft, geschrieben wird in eine neue Temp-Datei im Zielordner
 * (O_EXCL, folgt keinem Link), die dann per rename an ihren Platz kommt. Zeigt der Ordner vor dem rename woandershin,
 * wird abgebrochen. Eine vorhandene Datei (auch über einen Link im Projekt) behält ihre Rechte. Liefert den Pfad.
 */
export async function writeProjectFile(cwd: string, target: string, content: string): Promise<string> {
  const root = await realpath(cwd);
  await mkdir(dirname(target), { recursive: true });
  const destination = checkedPath(root, target);
  const directory = dirname(destination);
  const existing = await stat(destination).catch(() => null);
  const temporary = join(directory, `.${basename(destination)}.${randomUUID()}.tmp`);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const handle = await open(temporary, flags);
  try {
    try {
      await handle.writeFile(content, 'utf8');
      if (existing) await handle.chmod(existing.mode & 0o7777);
    } finally {
      await handle.close();
    }
    if ((await realpath(directory)) !== directory) {
      throw new ToolError('Der Zielordner wurde während des Schreibens umgehängt; nichts geschrieben.');
    }
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return destination;
}

/**
 * Liest eine Datei im Projekt, ohne symbolischen Links zu folgen – weder bei der Datei noch bei einem Ordner dazwischen
 * (sonst landete z. B. favicon.png -> ~/.ssh/id_ed25519 in der Datenbank). Liefert null für Links, Dateien ausserhalb,
 * Nicht-Dateien und Dateien über maxBytes.
 */
export async function readProjectFile(
  root: string,
  path: string,
  maxBytes = Infinity,
): Promise<{ content: Buffer; mtimeMs: number } | null> {
  try {
    const realRoot = await realpath(root);
    const absolute = resolve(root, path);
    const rel = relative(resolve(root), absolute);
    if (!rel || rel.startsWith('..') || (await realpath(absolute)) !== resolve(realRoot, rel)) return null;
    // O_NOFOLLOW: wird die Datei nach der Prüfung durch einen Link ersetzt, schlägt das Öffnen fehl.
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxBytes) return null;
      return { content: await handle.readFile(), mtimeMs: info.mtimeMs };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export async function walkText(directory: string, root: string, query: string, matches: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (matches.length >= 50) {
      return;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        await walkText(path, root, query, matches);
      }
    } else if (entry.isFile() && !SECRET_NAME.test(entry.name) && (await stat(path)).size < MAX_FILE_BYTES) {
      const lines = (await readFile(path, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        if (matches.length < 50 && line.includes(query)) {
          matches.push(`${relative(root, path)}:${index + 1}: ${line.trim().slice(0, 200)}`);
        }
      });
    }
  }
}
