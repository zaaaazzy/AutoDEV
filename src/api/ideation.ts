import type { Express } from 'express';
import type { Pool } from 'pg';
import { EDITABLE_IDEATION_STATUSES, IDEATION_STATUS } from '../core/status.js';
import {
  buildUpdate,
  ESTIMATE_FIELDS,
  isRecord,
  isUuid,
  PRIORITIES,
  parseFields,
  parseLongText,
  parseCategory,
  parseOption,
  parseProjectSlug,
  parseTitle,
} from '../core/validation.js';

export const IDEA_COLUMNS = `id, title, description, status, priority, created_at AS "createdAt",
  effort_hours AS "effortHours", token_estimate AS "tokenEstimate", benefit, cost,
  agent_note AS "agentNote", category`;

export const IDEA_FIELDS = {
  title: { column: 'title', parse: parseTitle(180) },
  description: { column: 'description', parse: parseLongText },
  // Only these statuses can be set manually; the workflow sets requested, drafting, and accepted.
  status: { column: 'status', parse: parseOption(EDITABLE_IDEATION_STATUSES) },
  priority: { column: 'priority', parse: parseOption(PRIORITIES) },
  category: { column: 'category', parse: parseCategory },
  ...ESTIMATE_FIELDS,
};

export function registerIdeationRoutes(app: Express, pool: Pool): void {
  app.post('/api/projects/:slug/ideation', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    const body = request.body as unknown;
    const fields = parseFields(body, IDEA_FIELDS);
    if (!slug || !fields || !isRecord(body) || body.title === undefined) {
      response.status(400).json({ message: 'Invalid ideation item.' });
      return;
    }
    const values = new Map(fields.map((field) => [field.column, field.value]));
    const result = await pool.query(
      `INSERT INTO ideation_items (project_slug, title, description, status, priority,
                                   effort_hours, token_estimate, benefit, cost, category)
       VALUES ($1, $2, $3, COALESCE($4, 'idea'), COALESCE($5, 'medium'), $6, $7, $8, $9, $10)
       RETURNING ${IDEA_COLUMNS}`,
      [
        slug,
        values.get('title'),
        values.get('description') ?? '',
        values.get('status') ?? null,
        values.get('priority') ?? null,
        values.get('effort_hours') ?? null,
        values.get('token_estimate') ?? null,
        values.get('benefit') ?? null,
        values.get('cost') ?? null,
        values.get('category') ?? null,
      ],
    );
    response.status(201).json({ item: result.rows[0] });
  });

  app.patch('/api/ideation/:id', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    const fields = parseFields(request.body, IDEA_FIELDS);
    if (!fields) {
      response.status(400).json({ message: 'Invalid ideation update.' });
      return;
    }
    const update = buildUpdate(
      'ideation_items',
      request.params.id,
      fields,
      `${IDEA_COLUMNS}, project_slug AS "projectSlug"`,
    );
    const result = await pool.query(update.sql, update.values);
    if (!result.rows[0]) {
      response.status(404).json({ message: 'Ideation item not found.' });
      return;
    }
    response.json({ item: result.rows[0] });
  });

  // The author agent defines the idea; this is only possible from the manually editable statuses.
  app.post('/api/ideation/:id/define', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    const result = await pool.query(
      `UPDATE ideation_items SET status = '${IDEATION_STATUS.requested}', agent_note = NULL, updated_at = NOW()
        WHERE id = $1 AND status = ANY($2) RETURNING ${IDEA_COLUMNS}, project_slug AS "projectSlug"`,
      [request.params.id, [...EDITABLE_IDEATION_STATUSES]],
    );
    if (!result.rows[0]) {
      response.status(409).json({ message: 'Die Idee ist nicht mehr in Bearbeitung durch Menschen.' });
      return;
    }
    response.json({ item: result.rows[0] });
  });

  app.post('/api/ideation/:id/comments', async (request, response) => {
    const text = isRecord(request.body) && typeof request.body.body === 'string' ? request.body.body.trim() : '';
    if (!isUuid(request.params.id) || !text || text.length > 4000) {
      response.status(400).json({ message: 'Bitte einen Kommentar eingeben (max. 4000 Zeichen).' });
      return;
    }
    const encoded = /^Basic (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
    const author = Buffer.from(encoded, 'base64').toString().split(':')[0]?.slice(0, 60) || 'Nutzer';
    const result = await pool.query(
      `INSERT INTO ideation_comments (ideation_id, author, body)
       SELECT id, $2, $3 FROM ideation_items WHERE id = $1
       RETURNING id, ideation_id AS "ideationId", author, body, created_at AS "createdAt"`,
      [request.params.id, author, text],
    );
    if (!result.rows[0]) {
      response.status(404).json({ message: 'Idee nicht gefunden.' });
      return;
    }
    response.status(201).json({ item: result.rows[0] });
  });
}
