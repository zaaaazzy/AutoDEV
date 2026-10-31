import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Router } from 'express';
import type { Pool, PoolClient } from 'pg';
import { access } from './access.js';
import { generatedDocs } from './generated-docs.js';
import { publicBaseUrl } from './production-snippets.js';
import type { Principal } from './roles.js';
import { isAdmin } from './tenancy.js';
import { readProjectText } from '../core/project-paths.js';
import { INVALID, invalidInput, isUuid, parseFields, parseProjectSlug, parseTitle } from '../core/validation.js';

/** Höchstlänge eines Dokuments (Zeichen), das über die API gespeichert oder als Revision eingereicht wird. */
export const MAX_DOC_CONTENT = 30_000;
const MAX_API_CONTENT = MAX_DOC_CONTENT;
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
  pool: Pool | PoolClient,
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
    // Links (auch ein verlinkter docs-Ordner), Hardlinks, fehlende und zu grosse Dateien werden übersprungen:
    // Agents schreiben in den Ordner, ein Link auf ~/.ssh/… darf nicht für alle lesbar in `docs` landen.
    const content = await readProjectText(cwd, file, MAX_STORED_CONTENT);
    if (content === null) {
      continue;
    }
    try {
      await upsertDoc(pool, { projectSlug, kind: 'repo', title: file, content });
      synced += 1;
    } catch {
      // Wie bisher: ein fehlgeschlagener Eintrag hält den Lauf nicht an.
    }
  }
  return synced;
}

export function registerDocRoutes(app: Router, pool: Pool): void {
  app.get('/projects/:slug/docs', access({ tenant: 'project' }), async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Ungültiges Projekt.' });
      return;
    }
    const result = await pool.query(
      `SELECT ${DOC_COLUMNS} FROM docs WHERE project_slug = $1
        ORDER BY CASE kind WHEN 'manual' THEN 0 WHEN 'sprint' THEN 1 WHEN 'order' THEN 2 ELSE 3 END, updated_at DESC
        LIMIT 300`,
      [slug],
    );
    // Testberichte, Agent-Einstellungen und Benutzerübersicht (erzeugt, schreibgeschützt)
    const generated = await generatedDocs(
      pool,
      slug,
      isAdmin(response.locals.principal as Principal | undefined),
      publicBaseUrl(request),
    );
    response.json({ docs: [...result.rows, ...generated] });
  });

  app.post('/projects/:slug/docs', access({ role: 'docs', tenant: 'project' }), async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    const fields = parseFields(request.body, DOC_FIELDS);
    const values = new Map((fields ?? []).map((field) => [field.column, field.value]));
    if (!slug || !fields || !values.get('title')) {
      response
        .status(400)
        .json(slug ? invalidInput(request.body, DOC_FIELDS, ['title']) : { message: 'Ungültiges Projekt.' });
      return;
    }
    // Nur anlegen: ein bestehendes Handbuch gleichen Titels bleibt unverändert. Änderungen laufen über
    // Revisionen (Vier-Augen-Prinzip), nicht über diesen Endpunkt.
    const result = await pool.query(
      `INSERT INTO docs (project_slug, kind, title, content) VALUES ($1, 'manual', $2, $3)
       ON CONFLICT (project_slug, kind, title) WHERE kind IN ('manual', 'sprint', 'repo') DO NOTHING
       RETURNING ${DOC_COLUMNS}`,
      [slug, values.get('title'), clip((values.get('content') as string) ?? '')],
    );
    if (!result.rows[0]) {
      response
        .status(409)
        .json({ message: 'Ein Dokument mit diesem Titel gibt es schon. Änderungen als Überarbeitung einreichen.' });
      return;
    }
    response.status(201).json({ doc: result.rows[0] });
  });

  // Kein PATCH /docs/:id: Titel und Inhalt ändern sich nur über POST /docs/:id/revisions und die Freigabe einer
  // anderen Person (doc-revisions.ts); dort gelten auch der Schreibschutz für `repo`/`request` und der Titel-409.

  app.delete('/docs/:id', access({ role: 'editor', tenant: 'docs' }), async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Nicht gefunden.' });
      return;
    }
    const result = await pool.query('DELETE FROM docs WHERE id = $1 RETURNING id', [request.params.id]);
    if (!result.rows[0]) {
      response.status(404).json({ message: 'Dokument nicht gefunden.' });
      return;
    }
    response.status(204).end();
  });
}
