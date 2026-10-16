import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { INVALID, buildUpdate, isUuid, parseFields, parseProjectSlug, parseTitle } from '../core/validation.js';

const MAX_API_CONTENT = 30_000;
const MAX_STORED_CONTENT = 200_000;
const DOC_COLUMNS = `id, project_slug AS "projectSlug", kind, title, content, development_id AS "developmentId",
  sprint_id AS "sprintId", created_at AS "createdAt", updated_at AS "updatedAt"`;
const DOC_FIELDS = {
  title: { column: 'title', parse: parseTitle(180) },
  content: {
    column: 'content',
    parse: (value: unknown) => (typeof value === 'string' && value.length <= MAX_API_CONTENT ? value : INVALID),
  },
};

const clip = (content: string): string => content.slice(0, MAX_STORED_CONTENT);

export async function upsertDoc(
  pool: Pool,
  doc: {
    projectSlug: string;
    kind: 'manual' | 'sprint' | 'repo';
    title: string;
    content: string;
    sprintId?: string | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO docs (project_slug, kind, title, content, sprint_id) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (project_slug, kind, title) WHERE kind IN ('manual', 'sprint', 'repo')
     DO UPDATE SET content = EXCLUDED.content, sprint_id = EXCLUDED.sprint_id, updated_at = NOW()`,
    [doc.projectSlug, doc.kind, doc.title.slice(0, 180), clip(doc.content), doc.sprintId ?? null],
  );
}

export async function saveOrderDoc(
  pool: Pool,
  doc: { projectSlug: string; developmentId: string; title: string; content: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO docs (project_slug, kind, title, content, development_id) VALUES ($1, 'order', $2, $3, $4)
     ON CONFLICT (development_id) WHERE kind = 'order'
     DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content, updated_at = NOW()`,
    [doc.projectSlug, doc.title.slice(0, 180), clip(doc.content), doc.developmentId],
  );
}

export async function readManual(pool: Pool, projectSlug: string, title: string): Promise<string> {
  const result = await pool.query<{ content: string }>(
    `SELECT content FROM docs WHERE project_slug = $1 AND kind = 'manual' AND title = $2`,
    [projectSlug, title],
  );
  return result.rows[0]?.content ?? '';
}

/** Mirrors README.md and docs/*.md of the repository into the tool so everything is documented in one place. */
export async function syncRepoDocs(pool: Pool, projectSlug: string, cwd: string): Promise<number> {
  const files: string[] = [];
  try {
    files.push('README.md');
    for (const entry of await readdir(join(cwd, 'docs'))) {
      if (entry.endsWith('.md')) {
        files.push(join('docs', entry));
      }
    }
  } catch {
    // A project without a docs directory is fine.
  }
  let synced = 0;
  for (const file of files) {
    try {
      const path = join(cwd, file);
      if ((await stat(path)).size > MAX_STORED_CONTENT) {
        continue;
      }
      await upsertDoc(pool, { projectSlug, kind: 'repo', title: file, content: await readFile(path, 'utf8') });
      synced += 1;
    } catch {
      // Missing file: skip.
    }
  }
  return synced;
}

export function registerDocRoutes(app: Express, pool: Pool): void {
  app.get('/api/projects/:slug/docs', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Invalid project slug.' });
      return;
    }
    const result = await pool.query(
      `SELECT ${DOC_COLUMNS} FROM docs WHERE project_slug = $1
        ORDER BY CASE kind WHEN 'manual' THEN 0 WHEN 'sprint' THEN 1 WHEN 'order' THEN 2 ELSE 3 END, updated_at DESC
        LIMIT 300`,
      [slug],
    );
    response.json({ docs: result.rows });
  });

  app.post('/api/projects/:slug/docs', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    const fields = parseFields(request.body, DOC_FIELDS);
    const values = new Map((fields ?? []).map((field) => [field.column, field.value]));
    if (!slug || !fields || !values.get('title')) {
      response.status(400).json({ message: 'Invalid document.' });
      return;
    }
    await upsertDoc(pool, {
      projectSlug: slug,
      kind: 'manual',
      title: values.get('title') as string,
      content: (values.get('content') as string) ?? '',
    });
    const result = await pool.query(
      `SELECT ${DOC_COLUMNS} FROM docs WHERE project_slug = $1 AND kind = 'manual' AND title = $2`,
      [slug, values.get('title')],
    );
    response.status(201).json({ doc: result.rows[0] });
  });

  app.patch('/api/docs/:id', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    const fields = parseFields(request.body, DOC_FIELDS);
    if (!fields) {
      response.status(400).json({ message: 'Invalid document update.' });
      return;
    }
    const update = buildUpdate('docs', request.params.id, fields, DOC_COLUMNS);
    const result = await pool.query(update.sql, update.values);
    if (!result.rows[0]) {
      response.status(404).json({ message: 'Document not found.' });
      return;
    }
    response.json({ doc: result.rows[0] });
  });

  app.delete('/api/docs/:id', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    const result = await pool.query('DELETE FROM docs WHERE id = $1 RETURNING id', [request.params.id]);
    if (!result.rows[0]) {
      response.status(404).json({ message: 'Document not found.' });
      return;
    }
    response.status(204).end();
  });
}
