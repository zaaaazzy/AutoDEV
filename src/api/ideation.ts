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
  TITLE_MAX,
  validText,
} from '../core/validation.js';
import type { Principal } from './roles.js';

export const IDEA_COLUMNS = `id, title, description, status, priority, created_at AS "createdAt",
  effort_hours AS "effortHours", token_estimate AS "tokenEstimate", benefit, cost,
  agent_note AS "agentNote", category, source, rejection_reason AS "rejectionReason"`;

/** Herkunft einer Idee; `routine`, `production` und `github` sind vorgesehen, werden aber noch nicht befüllt. */
export const IDEA_SOURCES = new Set(['human', 'visionary', 'routine', 'production', 'github']);
export const MAX_REJECTION_REASON = 1000;

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
    if (!validText(body.title, TITLE_MAX)) {
      response
        .status(400)
        .json({ message: `Titel bitte kurz halten (max. ${TITLE_MAX} Zeichen); Details in die Beschreibung.` });
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

  // Ablehnen mit Grund: Der Grund steht an der Idee und als Kommentar; der Visionär beachtet ihn beim nächsten Lauf.
  app.post('/api/ideation/:id/reject', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    const body = request.body as unknown;
    const reason = isRecord(body) && typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason || reason.length > MAX_REJECTION_REASON) {
      response
        .status(400)
        .json({ message: `Bitte einen Ablehnungsgrund angeben (max. ${MAX_REJECTION_REASON} Zeichen).` });
      return;
    }
    const result = await pool.query(
      `UPDATE ideation_items SET status = '${IDEATION_STATUS.rejected}', rejection_reason = $2, updated_at = NOW()
        WHERE id = $1 AND status = ANY($3) RETURNING ${IDEA_COLUMNS}, project_slug AS "projectSlug"`,
      [request.params.id, reason, [...EDITABLE_IDEATION_STATUSES]],
    );
    if (!result.rows[0]) {
      response.status(409).json({ message: 'Die Idee kann nicht mehr abgelehnt werden.' });
      return;
    }
    const principal = response.locals.principal as Principal | undefined;
    await pool.query(
      `INSERT INTO ideation_comments (ideation_id, author, author_kind, body) VALUES ($1, $2, 'user', $3)`,
      [
        request.params.id,
        (principal?.displayName || principal?.username || 'Nutzer').slice(0, 60),
        `**Abgelehnt:** ${reason}`,
      ],
    );
    response.json({ item: result.rows[0] });
  });
}
