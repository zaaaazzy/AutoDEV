import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import express, { type Express } from 'express';
import type { Pool } from 'pg';
import { isUuid, parseProjectSlug } from '../core/validation.js';

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_IDEA = 10;
const UPLOAD_WINDOW_SECONDS = 120;
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

export function registerAttachmentRoutes(app: Express, pool: Pool): void {
  const rawImage = express.raw({ type: IMAGE_TYPES, limit: MAX_ATTACHMENT_BYTES });

  app.get('/api/projects/:slug/attachments', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Invalid project slug.' });
      return;
    }
    const result = await pool.query(
      `SELECT a.id, a.ideation_id AS "ideationId", a.filename, a.mime, a.size
         FROM ideation_attachments a JOIN ideation_items i ON i.id = a.ideation_id
        WHERE i.project_slug = $1 ORDER BY a.created_at`,
      [slug],
    );
    response.json({ attachments: result.rows });
  });

  app.post('/api/ideation/:id/attachments', rawImage, async (request, response) => {
    const data: unknown = request.body;
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    if (!Buffer.isBuffer(data) || data.length === 0) {
      response.status(415).json({ message: 'Nur Bilder (PNG, JPEG, WebP, GIF) bis 5 MB sind erlaubt.' });
      return;
    }
    const mime = request.header('content-type')?.split(';')[0]?.trim() ?? '';
    const result = await pool.query(
      `INSERT INTO ideation_attachments (ideation_id, filename, mime, size, data)
       SELECT i.id, $2, $3, $4, $5 FROM ideation_items i
        WHERE i.id = $1
          AND i.created_at > NOW() - make_interval(secs => $7)
          AND (SELECT count(*) FROM ideation_attachments WHERE ideation_id = i.id) < $6
       RETURNING id, ideation_id AS "ideationId", filename, mime, size`,
      [
        request.params.id,
        safeFilename(request.query.name),
        mime,
        data.length,
        data,
        MAX_ATTACHMENTS_PER_IDEA,
        UPLOAD_WINDOW_SECONDS,
      ],
    );
    if (!result.rows[0]) {
      response.status(409).json({
        message: `Bilder können nur direkt beim Erstellen der Idee angehängt werden (max. ${MAX_ATTACHMENTS_PER_IDEA}).`,
      });
      return;
    }
    response.status(201).json({ attachment: result.rows[0] });
  });

  app.get('/api/attachments/:id', async (request, response) => {
    const result = isUuid(request.params.id)
      ? await pool.query(`SELECT mime, data FROM ideation_attachments WHERE id = $1`, [request.params.id])
      : { rows: [] };
    const row = result.rows[0] as { mime: string; data: Buffer } | undefined;
    if (!row) {
      response.status(404).json({ message: 'Not found.' });
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

  app.delete('/api/attachments/:id', async (request, response) => {
    const result = isUuid(request.params.id)
      ? await pool.query(`DELETE FROM ideation_attachments WHERE id = $1`, [request.params.id])
      : { rowCount: 0 };
    if (!result.rowCount) {
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    response.status(204).end();
  });
}

/** Writes the images of the originating idea into the project folder so CLI agents can open them. */
export async function materializeAttachments(
  pool: Pool,
  ideationId: string | null | undefined,
  itemId: string,
  cwd: string,
): Promise<string[]> {
  const directory = join(cwd, ATTACHMENT_DIRECTORY, itemId);
  await rm(directory, { recursive: true, force: true });
  if (!ideationId) {
    return [];
  }
  const result = await pool.query<{ id: string; filename: string; data: Buffer }>(
    `SELECT id, filename, data FROM ideation_attachments WHERE ideation_id = $1 ORDER BY created_at`,
    [ideationId],
  );
  if (!result.rows.length) {
    return [];
  }
  await mkdir(directory, { recursive: true });
  const paths: string[] = [];
  for (const [index, row] of result.rows.entries()) {
    const path = join(ATTACHMENT_DIRECTORY, itemId, `${index + 1}-${safeFilename(row.filename)}`);
    await writeFile(join(cwd, path), row.data);
    paths.push(path);
  }
  return paths;
}
