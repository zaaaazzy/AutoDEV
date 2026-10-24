import { join } from 'node:path';
import express, { type Router } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import { createProjectDirectory, removeProjectDirectory, writeNewProjectFile } from '../core/project-paths.js';
import { isUuid, parseProjectSlug } from '../core/validation.js';

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_IDEA = 10;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const ATTACHMENT_DIRECTORY = join('.dev-log', 'attachments');

export function safeFilename(name: unknown): string {
  const base = typeof name === 'string' ? (name.split(/[\\/]/).pop() ?? '') : '';
  const cleaned = base
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .trim()
    .slice(0, 120);
  return cleaned && !cleaned.startsWith('.') ? cleaned : 'bild';
}

export function registerAttachmentRoutes(app: Router, pool: Pool): void {
  const rawImage = express.raw({ type: IMAGE_TYPES, limit: MAX_ATTACHMENT_BYTES });

  app.get('/projects/:slug/attachments', access({ tenant: 'project' }), async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Ungültiges Projekt.' });
      return;
    }
    const result = await pool.query(
      `SELECT a.id, a.ideation_id AS "ideationId", a.bug_id AS "bugId", a.filename, a.mime, a.size
         FROM ideation_attachments a
         LEFT JOIN ideation_items i ON i.id = a.ideation_id
         LEFT JOIN bugs b ON b.id = a.bug_id
        WHERE COALESCE(i.project_slug, b.project_slug) = $1 ORDER BY a.created_at`,
      [slug],
    );
    response.json({ attachments: result.rows });
  });

  // Bilder zu Ideen und Bugs; owner bestimmt die Spalte, die übrige Logik ist identisch.
  for (const owner of [
    {
      path: '/ideation/:id/attachments',
      tenant: 'ideation',
      table: 'ideation_items',
      column: 'ideation_id',
      label: 'Idee',
    },
    { path: '/bugs/:id/attachments', tenant: 'bugs', table: 'bugs', column: 'bug_id', label: 'Bug' },
  ] as const) {
    app.post(owner.path, access({ role: 'plan', tenant: owner.tenant }), rawImage, async (request, response) => {
      const data: unknown = request.body;
      if (!isUuid(request.params.id)) {
        response.status(404).json({ message: 'Nicht gefunden.' });
        return;
      }
      if (!Buffer.isBuffer(data) || data.length === 0) {
        response.status(415).json({ message: 'Nur Bilder (PNG, JPEG, WebP, GIF) bis 5 MB sind erlaubt.' });
        return;
      }
      const mime = request.header('content-type')?.split(';')[0]?.trim() ?? '';
      const result = await pool.query(
        `INSERT INTO ideation_attachments (${owner.column}, filename, mime, size, data)
         SELECT o.id, $2, $3, $4, $5 FROM ${owner.table} o
          WHERE o.id = $1
            AND (SELECT count(*) FROM ideation_attachments WHERE ${owner.column} = o.id) < $6
         RETURNING id, ideation_id AS "ideationId", bug_id AS "bugId", filename, mime, size`,
        [request.params.id, safeFilename(request.query.name), mime, data.length, data, MAX_ATTACHMENTS_PER_IDEA],
      );
      if (!result.rows[0]) {
        response.status(409).json({
          message: `${owner.label} nicht gefunden oder bereits ${MAX_ATTACHMENTS_PER_IDEA} Bilder angehängt.`,
        });
        return;
      }
      response.status(201).json({ attachment: result.rows[0] });
    });
  }

  app.get('/attachments/:id', access({ tenant: 'attachments' }), async (request, response) => {
    const result = isUuid(request.params.id)
      ? await pool.query(`SELECT mime, data FROM ideation_attachments WHERE id = $1`, [request.params.id])
      : { rows: [] };
    const row = result.rows[0] as { mime: string; data: Buffer } | undefined;
    if (!row) {
      response.status(404).json({ message: 'Nicht gefunden.' });
      return;
    }
    response.set({
      'Content-Type': row.mime,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Cache-Control': 'private, max-age=3600',
    });
    response.send(row.data);
  });

  app.delete('/attachments/:id', access({ role: 'plan', tenant: 'attachments' }), async (request, response) => {
    const result = isUuid(request.params.id)
      ? await pool.query(`DELETE FROM ideation_attachments WHERE id = $1`, [request.params.id])
      : { rowCount: 0 };
    if (!result.rowCount) {
      response.status(404).json({ message: 'Nicht gefunden.' });
      return;
    }
    response.status(204).end();
  });
}

/** Writes the images of the originating idea or bug into the project folder so CLI agents can open them. */
export async function materializeAttachments(
  pool: Pool,
  source: { ideationId?: string | null; bugId?: string | null },
  itemId: string,
  cwd: string,
): Promise<string[]> {
  const relative = join(ATTACHMENT_DIRECTORY, itemId);
  // Ohne Links: ist `.dev-log` oder `attachments` ein Link, wird weder gelöscht noch geschrieben.
  if (!isUuid(itemId) || !(await removeProjectDirectory(cwd, relative))) {
    return [];
  }
  if (!source.ideationId && !source.bugId) {
    return [];
  }
  const result = await pool.query<{ id: string; filename: string; data: Buffer }>(
    `SELECT id, filename, data FROM ideation_attachments
      WHERE ideation_id = $1 OR bug_id = $2 ORDER BY created_at`,
    [source.ideationId ?? null, source.bugId ?? null],
  );
  if (!result.rows.length) {
    return [];
  }
  const directory = await createProjectDirectory(cwd, relative);
  if (!directory) {
    return [];
  }
  const paths: string[] = [];
  for (const [index, row] of result.rows.entries()) {
    const name = `${index + 1}-${safeFilename(row.filename)}`;
    if (await writeNewProjectFile(directory, name, row.data)) {
      paths.push(join(relative, name));
    }
  }
  return paths;
}
