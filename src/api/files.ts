import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { SECRET_IN_COMMAND } from '../agent/tool-permissions.js';
import { parseProjectSlug } from '../core/validation.js';

const PREVIEW_BYTES = 24_000;
const PREVIEW_LINES = 80;

export interface FilePreview {
  path: string;
  content: string;
  truncated: boolean;
  binary: boolean;
}

/**
 * In Docker the project folders are mounted read-only under another root (DEV_LOG_PROJECTS_MOUNT);
 * the stored repository path is the host path (DEV_LOG_PROJECTS_HOST_ROOT).
 */
export function containerPath(repository: string, environment: NodeJS.ProcessEnv = process.env): string {
  const hostRoot = environment.DEV_LOG_PROJECTS_HOST_ROOT?.replace(/\/$/, '');
  const mount = environment.DEV_LOG_PROJECTS_MOUNT?.replace(/\/$/, '');
  if (!hostRoot || !mount) return repository;
  return repository === hostRoot || repository.startsWith(`${hostRoot}/`)
    ? `${mount}${repository.slice(hostRoot.length)}`
    : repository;
}

/** Reads the start of a text file inside the repository; null for paths outside it, secrets or Git internals. */
export async function readFilePreview(repository: string, requested: string): Promise<FilePreview | null> {
  if (!requested || requested.length > 500 || requested.includes('\0')) return null;
  const root = await realpath(repository).catch(() => null);
  if (!root) return null;
  const target = await realpath(isAbsolute(requested) ? requested : resolve(root, requested)).catch(() => null);
  if (!target) return null;
  const inside = relative(root, target);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return null;
  if (inside.split(sep).includes('.git') || SECRET_IN_COMMAND.test(inside)) return null;
  const handle = await open(target, 'r').catch(() => null);
  if (!handle) return null;
  try {
    if (!(await handle.stat()).isFile()) return null;
    const buffer = Buffer.alloc(PREVIEW_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, Math.min(bytesRead, PREVIEW_BYTES));
    if (bytes.includes(0)) return { path: inside, content: '', truncated: false, binary: true };
    const lines = bytes.toString('utf8').split('\n');
    return {
      path: inside,
      content: lines.slice(0, PREVIEW_LINES).join('\n'),
      truncated: bytesRead > PREVIEW_BYTES || lines.length > PREVIEW_LINES,
      binary: false,
    };
  } finally {
    await handle.close();
  }
}

export function registerFileRoutes(app: Express, pool: Pool): void {
  app.get('/api/projects/:slug/file', async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      const path = typeof request.query.path === 'string' ? request.query.path : '';
      if (!slug || !path) return void response.status(400).json({ message: 'Projekt und Pfad erforderlich.' });
      const repository = (
        await pool.query<{ repository: string }>('SELECT repository FROM projects WHERE slug = $1', [slug])
      ).rows[0]?.repository;
      const preview = repository ? await readFilePreview(containerPath(repository), path) : null;
      if (!preview) return void response.status(404).json({ message: 'Datei nicht verfügbar.' });
      response.set('Cache-Control', 'no-store').json(preview);
    } catch (error) {
      next(error);
    }
  });
}
