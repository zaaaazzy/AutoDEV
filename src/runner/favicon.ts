import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Pool } from 'pg';

/** Favicon eines Projekts: Der Worker sieht die Projektordner, der Server-Container nicht – daher in der Datenbank. */
const CANDIDATES = [
  'favicon.svg',
  'favicon.ico',
  'favicon.png',
  'public/favicon.svg',
  'public/favicon.ico',
  'public/favicon.png',
  'frontend/public/favicon.svg',
  'frontend/public/favicon.ico',
  'frontend/public/favicon.png',
  'frontend/src/favicon.svg',
  'frontend/src/favicon.ico',
  'frontend/src/favicon.png',
  'src/favicon.svg',
  'src/favicon.ico',
  'src/favicon.png',
  'static/favicon.ico',
  'web/public/favicon.ico',
  'client/public/favicon.ico',
];
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.angular', '.next', 'out', 'tmp']);
const MAX_BYTES = 256 * 1024;
const TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

async function search(dir: string, depth: number): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const own = entries.find((entry) => entry.isFile() && /^favicon\.(svg|ico|png)$/i.test(entry.name));
  if (own) return join(dir, own.name);
  if (depth <= 0) return null;
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
    const found = await search(join(dir, entry.name), depth - 1);
    if (found) return found;
  }
  return null;
}

/** Bevorzugt die üblichen Orte, sonst eine flache Suche (max. 3 Ebenen, ohne Build- und Abhängigkeitsordner). */
export async function findFavicon(cwd: string): Promise<string | null> {
  for (const candidate of CANDIDATES) {
    const path = join(cwd, candidate);
    if ((await stat(path).catch(() => null))?.isFile()) return path;
  }
  return search(cwd, 3);
}

/** Speichert das Favicon, wenn es sich seit dem letzten Abgleich geändert hat (oder entfernt es). */
export async function syncFavicon(pool: Pool, project: string, cwd: string): Promise<void> {
  const path = await findFavicon(cwd);
  const info = path ? await stat(path).catch(() => null) : null;
  const type = path ? TYPES[extname(path).toLowerCase()] : undefined;
  const stored = (
    await pool.query<{ mtime: Date | null }>('SELECT favicon_mtime AS mtime FROM projects WHERE slug = $1', [project])
  ).rows[0];
  if (!stored) return;
  if (!path || !info || !type || info.size > MAX_BYTES) {
    if (stored.mtime) {
      await pool.query(
        'UPDATE projects SET favicon = NULL, favicon_type = NULL, favicon_mtime = NULL WHERE slug = $1',
        [project],
      );
    }
    return;
  }
  if (stored.mtime && stored.mtime.getTime() === Math.floor(info.mtimeMs)) return;
  await pool.query('UPDATE projects SET favicon = $2, favicon_type = $3, favicon_mtime = $4 WHERE slug = $1', [
    project,
    await readFile(path),
    type,
    new Date(Math.floor(info.mtimeMs)),
  ]);
}
