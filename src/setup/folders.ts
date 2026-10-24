import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { insideFolder, isWindowsPath, normalizeFolder, projectFolderError, projectRoots } from '../core/validation.js';

export interface FolderEntry {
  name: string;
  path: string;
  git: boolean;
}

export interface FolderListing {
  /** Angezeigter Ordner; null = Übersicht der Projektbereiche. */
  path: string | null;
  /** Eine Ebene höher (null = zurück zur Übersicht). */
  parent: string | null;
  roots: string[];
  folders: FolderEntry[];
  /** Darf der angezeigte Ordner Projektordner sein? */
  selectable: boolean;
  /** Warum nicht (z. B. zu breit oder ausserhalb des Projektbereichs). */
  reason: string | null;
}

const MAX_FOLDERS = 400;
const SKIPPED = new Set(['node_modules', 'dist', 'build', 'coverage']);

/** Bereiche, in denen gewählt werden darf: DEV_LOG_PROJECT_ROOTS, sonst Benutzerordner und Laufwerke. */
function browseRoots(environment: NodeJS.ProcessEnv): string[] {
  const roots = projectRoots(environment);
  if (roots.length) return roots;
  return process.platform === 'win32' ? [normalizeFolder(homedir()) ?? homedir()] : [homedir(), '/Volumes'];
}

/**
 * Ordnerauswahl für den Projektordner: listet die Unterordner eines Ordners im Projektbereich (läuft auf dem Rechner,
 * der Server im Container sieht die Ordner nicht). Versteckte Ordner und Build-Ordner fehlen, Git-Repositories sind
 * markiert.
 */
export async function listFolders(
  requested: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<FolderListing> {
  const roots = browseRoots(environment);
  const raw = typeof requested === 'string' ? requested.trim() : '';
  const entry = async (path: string): Promise<FolderEntry> => ({
    name: path.split(/[\\/]/).pop() || path,
    path,
    git: existsSync(join(path, '.git')),
  });
  if (!raw) {
    const available = roots.filter((root) => existsSync(root));
    return {
      path: null,
      parent: null,
      roots,
      folders: await Promise.all(available.map(entry)).then((list) =>
        list.map((item) => ({ ...item, name: item.path })),
      ),
      selectable: false,
      reason: null,
    };
  }
  // Doppelte Trenner wie bisher tolerieren, alles andere (relativ, „.“, „..“) ist ungültig.
  const path = normalizeFolder(isWindowsPath(raw) ? raw : raw.replace(/\/{2,}/g, '/'));
  if (!path) throw new Error('Ungültiger Ordner.');
  const root = roots.find((candidate) => insideFolder(path, candidate));
  if (!root) throw new Error(`Ordner liegt ausserhalb des Projektbereichs (${roots.join(', ')}).`);
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`Ordner nicht gefunden: ${path}`);
  const names = (await readdir(path, { withFileTypes: true }))
    .filter((item) => !item.name.startsWith('.') && !SKIPPED.has(item.name))
    .filter((item) => item.isDirectory() || (item.isSymbolicLink() && existsSync(join(path, item.name, '.'))))
    .map((item) => item.name)
    .sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }))
    .slice(0, MAX_FOLDERS);
  const reason = projectFolderError(path, environment);
  return {
    path,
    parent: insideFolder(root, path) ? null : (isWindowsPath(path) ? win32 : posix).dirname(path),
    roots,
    folders: await Promise.all(names.map((name) => entry(join(path, name)))),
    selectable: !reason,
    reason,
  };
}
