import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';

/**
 * Dateizugriffe des Workers im Projektordner, ohne Symlinks zu folgen. Agents schreiben in den Ordner; ein Link
 * `docs/x.md -> ~/.ssh/id_rsa` oder `.dev-log -> /anderswo` darf weder Fremdes in die Datenbank bringen noch
 * Löschen/Schreiben ausserhalb des Projekts auslösen. Regel (fail-closed): Jeder Pfadteil unterhalb des
 * Projektordners muss ein echter Ordner bzw. eine echte Datei sein – Symlinks werden nie verfolgt, auch nicht,
 * wenn sie innerhalb des Projekts enden. Gelesene Dateien dürfen keine Hardlinks sein (`nlink > 1`). Was sich
 * nicht sicher klären lässt, wird übersprungen (null/false), nicht geworfen.
 */

// Auf Windows gibt es O_NOFOLLOW nicht; dort greifen nur die lstat-Prüfungen.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Zerlegt einen relativen Pfad; absolute Pfade und `..` sind nie erlaubt. */
function segments(relative: string): string[] | null {
  if (!relative || isAbsolute(relative)) return null;
  const parts = normalize(relative)
    .split(/[\\/]+/)
    .filter((part) => part && part !== '.');
  return parts.length && !parts.includes('..') ? parts : null;
}

/** Echter Pfad des Projektordners. Der Ordner selbst darf ein Link sein (z. B. /Volumes/…), was darunter liegt nicht. */
async function projectRoot(root: string): Promise<string | null> {
  try {
    const real = await realpath(root);
    return (await lstat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** true, wenn `path` gleich `root` ist oder darin liegt (mit Trennzeichen, damit `/repo-evil` nicht zu `/repo` zählt). */
export function isInside(root: string, path: string): boolean {
  const base = root.endsWith(sep) ? root : root + sep;
  return path === root || path.startsWith(base);
}

/**
 * Prüft die Ordner `parts` unterhalb von `root` per lstat: alle müssen echte Ordner sein. Mit `create` werden fehlende
 * einzeln angelegt (kein `recursive`, das Links folgen würde). Liefert den absoluten Pfad oder null.
 */
async function realDirectory(root: string, parts: readonly string[], create: boolean): Promise<string | null> {
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      if (!(await lstat(current)).isDirectory()) return null;
    } catch (error) {
      if (!create || (error as { code?: string }).code !== 'ENOENT') return null;
      try {
        await mkdir(current);
      } catch {
        return null;
      }
      if (!(await lstat(current).catch(() => null))?.isDirectory()) return null;
    }
  }
  // Doppelt hält besser: auch der echte Pfad muss im Projekt liegen.
  const real = await realpath(current).catch(() => null);
  return real && isInside(root, real) ? current : null;
}

/**
 * Liest eine Projektdatei als UTF-8, ohne Links zu folgen. null bei Link (Datei oder Elternordner), fehlender Datei,
 * Hardlink, Nicht-Datei oder mehr als `maxBytes`.
 */
export async function readProjectText(cwd: string, relative: string, maxBytes: number): Promise<string | null> {
  return (await readProjectFile(cwd, relative, maxBytes))?.toString('utf8') ?? null;
}

/** Wie readProjectText, aber roh (auch Binärdateien). */
export async function readProjectFile(cwd: string, relative: string, maxBytes: number): Promise<Buffer | null> {
  const parts = segments(relative);
  const root = await projectRoot(cwd);
  if (!parts || !root) return null;
  const directory = await realDirectory(root, parts.slice(0, -1), false);
  if (!directory) return null;
  const path = join(directory, parts.at(-1)!);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) return null;
    // Nach dem Öffnen nochmals: Elternordner unverändert und dieselbe Datei wie unter dem Pfad (kein Austausch dazwischen).
    const again = await lstat(path).catch(() => null);
    if (!again || again.ino !== info.ino || again.dev !== info.dev) return null;
    if ((await realDirectory(root, parts.slice(0, -1), false)) !== directory) return null;
    const content = await handle.readFile();
    return content.length > maxBytes ? null : content;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Entfernt den Ordner `relative` im Projekt. Fehlt ein Elternordner, gibt es nichts zu löschen (true); ist einer ein
 * Link, wird nichts gelöscht (false). Ist der Ordner selbst ein Link, verschwindet nur der Link – `rm` mit
 * `recursive` folgt darunter keinen Links.
 */
export async function removeProjectDirectory(cwd: string, relative: string): Promise<boolean> {
  const parts = segments(relative);
  const root = await projectRoot(cwd);
  if (!parts || !root) return false;
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const info = await lstat(current).catch((error: { code?: string }) => (error.code === 'ENOENT' ? null : false));
    if (info === null) return true;
    if (!info || !info.isDirectory()) return false;
  }
  const real = await realpath(current).catch(() => null);
  if (!real || !isInside(root, real)) return false;
  await rm(join(current, parts.at(-1)!), { recursive: true, force: true });
  return true;
}

/** Legt den Ordner `relative` im Projekt Teil für Teil an, ohne Links zu folgen. null, wenn ein Teil ein Link ist. */
export async function createProjectDirectory(cwd: string, relative: string): Promise<string | null> {
  const parts = segments(relative);
  const root = await projectRoot(cwd);
  return parts && root ? realDirectory(root, parts, true) : null;
}

/**
 * Schreibt eine neue Datei in einen mit `createProjectDirectory` angelegten Ordner. Bestehende Dateien und Links
 * werden nicht überschrieben (`O_EXCL`, `O_NOFOLLOW`); false, wenn das Schreiben abgelehnt wurde.
 */
export async function writeNewProjectFile(directory: string, name: string, data: Uint8Array): Promise<boolean> {
  if (!name || name !== segments(name)?.[0]) return false;
  let handle;
  try {
    handle = await open(
      join(directory, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o644,
    );
  } catch {
    return false;
  }
  try {
    await handle.writeFile(data);
    return true;
  } finally {
    await handle.close();
  }
}
