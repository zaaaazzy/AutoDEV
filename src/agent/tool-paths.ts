import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const BACKUP_DIRECTORY = '.dev-log-backups';
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
export const SECRET_NAME = /^\.env|\.(?:pem|key)$|^id_(?:rsa|ed25519|ecdsa)/i;

export class ToolError extends Error {}

/** Gesperrte Pfadteile: Git, Abhängigkeiten, Sicherungen und Geheimnisse (Pfad relativ zum Projekt). */
function blockedPath(rel: string): boolean {
  return rel
    .split(sep)
    .filter(Boolean)
    .some((part) => {
      const lower = part.toLowerCase();
      return lower === '.git' || lower === 'node_modules' || lower === BACKUP_DIRECTORY || SECRET_NAME.test(part);
    });
}

export async function resolveInside(cwd: string, requested: unknown, forWrite = false): Promise<string> {
  if (typeof requested !== 'string' || !requested || requested.includes('\0')) {
    throw new ToolError('Ungültiger Pfad.');
  }
  const root = await realpath(cwd);
  const target = resolve(root, requested);
  const rel = relative(root, target);
  if (rel.startsWith('..') || resolve(root, rel) !== target) {
    throw new ToolError('Pfad liegt außerhalb des Projektverzeichnisses.');
  }
  if (blockedPath(rel)) {
    throw new ToolError('Zugriff auf diesen Pfad ist nicht erlaubt.');
  }
  // Resolve symlinks of the nearest existing ancestor so they cannot point outside the project or at a blocked path
  // (z. B. notes.txt -> .env oder hook -> .git/hooks/pre-commit).
  let existing = target;
  for (;;) {
    try {
      const real = await realpath(existing);
      if (real !== root && !real.startsWith(root + sep)) {
        throw new ToolError('Pfad liegt außerhalb des Projektverzeichnisses.');
      }
      if (blockedPath(join(relative(root, real), relative(existing, target)))) {
        throw new ToolError('Zugriff auf diesen Pfad ist nicht erlaubt.');
      }
      break;
    } catch (error) {
      if (error instanceof ToolError) {
        throw error;
      }
      // Ein Link ins Leere würde beim Schreiben sein (ungeprüftes) Ziel anlegen.
      if (
        await lstat(existing).then(
          (info) => info.isSymbolicLink(),
          () => false,
        )
      ) {
        throw new ToolError('Zugriff auf diesen Pfad ist nicht erlaubt.');
      }
      if (!forWrite && existing === target) {
        throw new ToolError('Pfad existiert nicht.');
      }
      existing = dirname(existing);
    }
  }
  return target;
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
