import type { Express } from 'express';
import type { Pool } from 'pg';
import { BUG_STATUSES, BUG_STATUS, type BugStatus } from '../core/status.js';
import { relatedResourceBelongsToProject } from './resource.js';
import {
  buildUpdate,
  isUuid,
  parseFields,
  parseLongText,
  parseNullableUuid,
  parseOption,
  parseProjectSlug,
  parseTitle,
} from '../core/validation.js';

const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const BUG_COLUMNS = `id, project_slug AS "projectSlug", title, description, severity, status, source,
  sprint_id AS "sprintId", fix_notes AS "fixNotes", created_at AS "createdAt", fixed_at AS "fixedAt"`;
const BUG_FIELDS = {
  title: { column: 'title', parse: parseTitle(180) },
  description: { column: 'description', parse: parseLongText },
  severity: { column: 'severity', parse: parseOption(SEVERITIES) },
  status: { column: 'status', parse: parseOption(BUG_STATUSES) },
  sprintId: { column: 'sprint_id', parse: parseNullableUuid },
  fixNotes: { column: 'fix_notes', parse: parseLongText },
};

/** Keeps the development order of a bug in line with the sprint the bug was added to. */
export async function syncBugOrder(pool: Pool, bugId: string): Promise<void> {
  await pool.query(
    `INSERT INTO development_items (project_slug, sprint_id, title, description, status, priority, kind, bug_id)
     SELECT b.project_slug, b.sprint_id, 'Bug: ' || b.title, b.description, 'planned',
            CASE b.severity WHEN 'critical' THEN 'high' WHEN 'high' THEN 'high' WHEN 'medium' THEN 'medium' ELSE 'low' END,
            'bug', b.id
       FROM bugs b
      WHERE b.id = $1 AND b.sprint_id IS NOT NULL AND b.status IN ('${BUG_STATUS.open}', '${BUG_STATUS.inProgress}')
     ON CONFLICT (bug_id) WHERE bug_id IS NOT NULL DO UPDATE
       SET sprint_id = EXCLUDED.sprint_id,
           status = CASE WHEN development_items.status IN ('backlog', 'done') THEN 'planned' ELSE development_items.status END,
           updated_at = NOW()`,
    [bugId],
  );
  await pool.query(
    `UPDATE development_items d SET sprint_id = NULL, status = 'backlog', updated_at = NOW()
       FROM bugs b
      WHERE d.bug_id = b.id AND b.id = $1 AND b.sprint_id IS NULL AND d.status IN ('planned', 'backlog')`,
    [bugId],
  );
  await pool.query(
    `DELETE FROM development_items d USING bugs b
      WHERE d.bug_id = b.id AND b.id = $1 AND b.status IN ('${BUG_STATUS.fixed}', '${BUG_STATUS.wontfix}') AND d.status IN ('planned', 'backlog')`,
    [bugId],
  );
}

/** Creates a bug report for a failed agent step unless an identical open bug already exists. */
export async function reportAgentBug(
  pool: Pool,
  bug: { projectSlug: string; title: string; description: string; sprintId?: string | null },
): Promise<string> {
  const title = bug.title.slice(0, 180);
  const created = await pool.query<{ id: string }>(
    `INSERT INTO bugs (project_slug, title, description, severity, source, sprint_id)
     SELECT $1, $2, $3, 'high', 'agent', NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM bugs WHERE project_slug = $1 AND title = $2 AND status IN ('${BUG_STATUS.open}', '${BUG_STATUS.inProgress}')
      ) RETURNING id`,
    [bug.projectSlug, title, bug.description.slice(0, 10_000)],
  );
  if (created.rows[0]) return created.rows[0].id;
  const existing = (
    await pool.query<{ id: string }>(
      `SELECT id FROM bugs WHERE project_slug = $1 AND title = $2 AND status IN ('${BUG_STATUS.open}', '${BUG_STATUS.inProgress}') ORDER BY created_at LIMIT 1`,
      [bug.projectSlug, title],
    )
  ).rows[0];
  if (!existing) throw new Error('Bug report could not be found after insertion.');
  return existing.id;
}

export interface KnownBug {
  title: string;
  description: string;
  severity: string;
  status: BugStatus;
  fixNotes: string;
}

export async function loadKnownBugs(pool: Pool, projectSlug: string, limit = 40): Promise<KnownBug[]> {
  const result = await pool.query<KnownBug>(
    `SELECT title, description, severity, status, fix_notes AS "fixNotes"
       FROM bugs
      WHERE project_slug = $1 AND status <> 'wontfix'
      ORDER BY CASE status WHEN '${BUG_STATUS.open}' THEN 0 WHEN '${BUG_STATUS.inProgress}' THEN 0 ELSE 1 END, updated_at DESC
      LIMIT $2`,
    [projectSlug, limit],
  );
  return result.rows;
}

export function registerBugRoutes(app: Express, pool: Pool): void {
  app.get('/api/projects/:slug/bugs', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Invalid project slug.' });
      return;
    }
    const result = await pool.query(
      `SELECT ${BUG_COLUMNS} FROM bugs WHERE project_slug = $1 ORDER BY created_at DESC LIMIT 500`,
      [slug],
    );
    response.json({ bugs: result.rows });
  });

  app.post('/api/projects/:slug/bugs', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    const fields = parseFields(request.body, BUG_FIELDS);
    const values = new Map((fields ?? []).map((field) => [field.column, field.value]));
    if (!slug || !fields || !values.get('title')) {
      response.status(400).json({ message: 'Invalid bug.' });
      return;
    }
    const sprintId = (values.get('sprint_id') as string | null | undefined) ?? null;
    const result = await pool.query(
      `INSERT INTO bugs (project_slug, title, description, severity, sprint_id)
       SELECT $1, $2, $3, COALESCE($4, 'medium'), s.id
         FROM (SELECT 1) seed LEFT JOIN sprints s ON s.id = $5 AND s.project_slug = $1
        WHERE $5::uuid IS NULL OR s.id IS NOT NULL
       RETURNING ${BUG_COLUMNS}`,
      [slug, values.get('title'), values.get('description') ?? '', values.get('severity') ?? null, sprintId],
    );
    if (!result.rows[0]) {
      response.status(400).json({ message: 'Sprint gehört zu einem anderen Projekt.' });
      return;
    }
    await syncBugOrder(pool, result.rows[0].id as string);
    response.status(201).json({ bug: result.rows[0] });
  });

  app.patch('/api/bugs/:id', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    const fields = parseFields(request.body, BUG_FIELDS);
    if (!fields) {
      response.status(400).json({ message: 'Invalid bug update.' });
      return;
    }
    const sprintId = fields.find((field) => field.column === 'sprint_id')?.value;
    if (typeof sprintId === 'string') {
      const sameProject = await relatedResourceBelongsToProject(pool, 'bugs', sprintId, request.params.id);
      if (!sameProject) {
        response.status(400).json({ message: 'Sprint gehört zu einem anderen Projekt.' });
        return;
      }
    }
    const withFixDate = fields.some((field) => field.column === 'status')
      ? [
          ...fields,
          {
            column: 'fixed_at',
            value: fields.find((field) => field.column === 'status')?.value === BUG_STATUS.fixed ? new Date() : null,
          },
        ]
      : fields;
    const update = buildUpdate('bugs', request.params.id, withFixDate, BUG_COLUMNS);
    const result = await pool.query(update.sql, update.values);
    if (!result.rows[0]) {
      response.status(404).json({ message: 'Bug not found.' });
      return;
    }
    if (fields.some((field) => field.column === 'sprint_id' || field.column === 'status')) {
      await syncBugOrder(pool, request.params.id);
    }
    response.json({ bug: result.rows[0] });
  });

  app.delete('/api/bugs/:id', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    const result = await pool.query('DELETE FROM bugs WHERE id = $1 RETURNING id', [request.params.id]);
    if (!result.rows[0]) {
      response.status(404).json({ message: 'Bug not found.' });
      return;
    }
    response.status(204).end();
  });
}
