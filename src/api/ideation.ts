import type { Router } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import { EDITABLE_IDEATION_STATUSES, IDEATION_STATUS } from '../core/status.js';
import {
  buildUpdate,
  manualEstimateSql,
  ESTIMATE_FIELDS,
  isRecord,
  invalidInput,
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
  effort_hours AS "effortHours", token_estimate AS "tokenEstimate", estimate_source AS "estimateSource", benefit, cost,
  agent_note AS "agentNote", category, source, rejection_reason AS "rejectionReason",
  external_ref AS "externalRef"`;

/** Herkunft einer Idee; `github` stammt aus dem Issue-Import, `routine` und `production` sind vorgesehen. */
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

export function registerIdeationRoutes(app: Router, pool: Pool): void {
  app.post('/projects/:slug/ideation', access({ role: 'plan', tenant: 'project' }), async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    const body = request.body as unknown;
    const fields = parseFields(body, IDEA_FIELDS);
    if (!slug || !fields || !isRecord(body) || body.title === undefined) {
      response.status(400).json(slug ? invalidInput(body, IDEA_FIELDS, ['title']) : { message: 'Ungültiges Projekt.' });
      return;
    }
    if (!validText(body.title, TITLE_MAX)) {
      response.status(400).json({
        field: 'title',
        message: `Titel bitte kurz halten (max. ${TITLE_MAX} Zeichen); Details in die Beschreibung.`,
      });
      return;
    }
    const values = new Map(fields.map((field) => [field.column, field.value]));
    const result = await pool.query(
      `INSERT INTO ideation_items (project_slug, title, description, status, priority,
                                   effort_hours, token_estimate, benefit, cost, category, estimate_source)
       VALUES ($1, $2, $3, COALESCE($4, 'idea'), COALESCE($5, 'medium'), $6, $7, $8, $9, $10,
               CASE WHEN $6::float8 IS NOT NULL OR $7::bigint IS NOT NULL THEN 'manual' END)
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

  app.patch('/ideation/:id', access({ role: 'plan', tenant: 'ideation' }), async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Nicht gefunden.' });
      return;
    }
    const fields = parseFields(request.body, IDEA_FIELDS);
    if (!fields) {
      response.status(400).json(invalidInput(request.body, IDEA_FIELDS));
      return;
    }
    // Solange der Auftragsautor schreibt (requested, drafting) oder der Auftrag steht (accepted), bleibt die Idee
    // unverändert; die Statusbedingung im UPDATE verhindert ein Überschreiben mitten im Lauf.
    const update = buildUpdate(
      'ideation_items',
      request.params.id,
      fields,
      `${IDEA_COLUMNS}, project_slug AS "projectSlug"`,
      { column: 'status', values: [...EDITABLE_IDEATION_STATUSES, IDEATION_STATUS.rejected] },
      manualEstimateSql(fields),
    );
    const result = await pool.query(update.sql, update.values);
    if (!result.rows[0]) {
      const exists = (await pool.query('SELECT 1 FROM ideation_items WHERE id = $1', [request.params.id])).rows[0];
      if (exists) {
        response.status(409).json({
          message:
            'Die Idee wird gerade vom Auftragsautor bearbeitet oder ist schon angenommen und bleibt unverändert.',
        });
        return;
      }
      response.status(404).json({ message: 'Idee nicht gefunden.' });
      return;
    }
    response.json({ item: result.rows[0] });
  });

  // The author agent defines the idea; this is only possible from the manually editable statuses.
  app.post('/ideation/:id/define', access({ role: 'plan', tenant: 'ideation' }), async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Nicht gefunden.' });
      return;
    }
    const result = await pool.query(
      `UPDATE ideation_items SET status = '${IDEATION_STATUS.requested}', updated_at = NOW(),
              agent_note = CASE WHEN source = 'visionary' THEN agent_note END
        WHERE id = $1 AND status = ANY($2) RETURNING ${IDEA_COLUMNS}, project_slug AS "projectSlug"`,
      [request.params.id, [...EDITABLE_IDEATION_STATUSES]],
    );
    if (!result.rows[0]) {
      response.status(409).json({ message: 'Die Idee ist nicht mehr in Bearbeitung durch Menschen.' });
      return;
    }
    response.json({ item: result.rows[0] });
  });

  // Massenaktionen der Ideenliste. Vor /ideation/:id/… registriert, sonst träfe :id das Wort „bulk“. Die Ideen
  // kommen aus dem Body, nicht aus dem Pfad: Der Mandant ist daher 'global', die Abfragen filtern selbst nach
  // allowedProjects (fremde Ideen gelten als nicht gefunden).
  app.post('/ideation/bulk/reject', access({ role: 'plan', tenant: 'global' }), async (request, response) => {
    const ids = parseBulkIds(request.body);
    const reason = parseRejectionReason(request.body);
    if (!ids || !reason) {
      response.status(400).json({ message: ids ? REJECTION_REASON_MESSAGE : BULK_IDS_MESSAGE });
      return;
    }
    const allowed = allowedSlugs(response.locals.allowedProjects);
    const author = authorName(response.locals.principal as Principal | undefined);
    const client = await pool.connect();
    let changed: BulkIdea[];
    try {
      await client.query('BEGIN');
      // Gleiche Regel wie die Einzel-Ablehnung: Die Statusbedingung schützt Ideen, die der Auftragsautor schreibt.
      changed = (
        await client.query<BulkIdea>(
          `UPDATE ideation_items SET status = '${IDEATION_STATUS.rejected}', rejection_reason = $2, updated_at = NOW()
            WHERE id = ANY($1::uuid[]) AND status = ANY($3) AND ($4::text[] IS NULL OR project_slug = ANY($4))
            RETURNING id, title`,
          [ids, reason, [...EDITABLE_IDEATION_STATUSES], allowed],
        )
      ).rows;
      if (changed.length) {
        await client.query(
          `INSERT INTO ideation_comments (ideation_id, author, author_kind, body)
           SELECT unnest($1::uuid[]), $2, 'user', $3`,
          [changed.map((idea) => idea.id), author, `**Abgelehnt:** ${reason}`],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    response.json({ rejected: changed, skipped: await skippedIdeas(pool, ids, changed, allowed) });
  });

  app.post('/ideation/bulk/priority', access({ role: 'plan', tenant: 'global' }), async (request, response) => {
    const ids = parseBulkIds(request.body);
    const body = request.body as unknown;
    const priority = isRecord(body) && typeof body.priority === 'string' ? body.priority : '';
    if (!ids || !PRIORITIES.has(priority)) {
      response.status(400).json({ message: ids ? PRIORITY_MESSAGE : BULK_IDS_MESSAGE });
      return;
    }
    const allowed = allowedSlugs(response.locals.allowedProjects);
    const changed = (
      await pool.query<BulkIdea>(
        `UPDATE ideation_items SET priority = $2, updated_at = NOW()
          WHERE id = ANY($1::uuid[]) AND status = ANY($3) AND ($4::text[] IS NULL OR project_slug = ANY($4))
          RETURNING id, title`,
        [ids, priority, [...EDITABLE_IDEATION_STATUSES], allowed],
      )
    ).rows;
    response.json({ changed, skipped: await skippedIdeas(pool, ids, changed, allowed) });
  });

  // Ablehnen mit Grund: Der Grund steht an der Idee und als Kommentar; der Visionär beachtet ihn beim nächsten Lauf.
  app.post('/ideation/:id/reject', access({ role: 'plan', tenant: 'ideation' }), async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Nicht gefunden.' });
      return;
    }
    const reason = parseRejectionReason(request.body);
    if (!reason) {
      response.status(400).json({ message: REJECTION_REASON_MESSAGE });
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
    await pool.query(
      `INSERT INTO ideation_comments (ideation_id, author, author_kind, body) VALUES ($1, $2, 'user', $3)`,
      [request.params.id, authorName(response.locals.principal as Principal | undefined), `**Abgelehnt:** ${reason}`],
    );
    response.json({ item: result.rows[0] });
  });
}

export const MAX_BULK_IDEAS = 200;
const BULK_IDS_MESSAGE = `Bitte 1 bis ${MAX_BULK_IDEAS} Ideen auswählen.`;
const REJECTION_REASON_MESSAGE = `Bitte einen Ablehnungsgrund angeben (max. ${MAX_REJECTION_REASON} Zeichen).`;
const PRIORITY_MESSAGE = 'Bitte eine Priorität wählen (Niedrig, Mittel, Hoch).';

interface BulkIdea {
  id: string;
  title: string;
}

/** Ablehnungsgrund aus dem Body (getrimmt); null = leer oder zu lang. */
function parseRejectionReason(body: unknown): string | null {
  const reason = isRecord(body) && typeof body.reason === 'string' ? body.reason.trim() : '';
  return reason && reason.length <= MAX_REJECTION_REASON ? reason : null;
}

/** Ideen-IDs einer Massenaktion (ohne Dubletten); null = keine, zu viele oder keine gültigen UUIDs. */
function parseBulkIds(body: unknown): string[] | null {
  const ids = isRecord(body) ? body.ids : undefined;
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_BULK_IDEAS) return null;
  if (!ids.every((id) => typeof id === 'string' && isUuid(id))) return null;
  // Kleinschreibung wie in den Antworten der Datenbank, damit geänderte und übersprungene IDs zusammenpassen.
  return [...new Set((ids as string[]).map((id) => id.toLowerCase()))];
}

function allowedSlugs(allowed: unknown): string[] | null {
  return allowed instanceof Set ? [...(allowed as Set<string>)] : null;
}

function authorName(principal: Principal | undefined): string {
  return (principal?.displayName || principal?.username || 'Nutzer').slice(0, 60);
}

/** Nicht geänderte Ideen mit Grund: im falschen Status „nicht möglich“, sonst (auch fremdes Projekt) „nicht gefunden“. */
async function skippedIdeas(
  pool: Pool,
  ids: string[],
  changed: BulkIdea[],
  allowed: string[] | null,
): Promise<{ id: string; title: string | null; status: string | null; reason: string }[]> {
  const done = new Set(changed.map((idea) => idea.id));
  const rest = ids.filter((id) => !done.has(id));
  if (!rest.length) return [];
  const found = new Map(
    (
      await pool.query<BulkIdea & { status: string }>(
        `SELECT id, title, status FROM ideation_items
          WHERE id = ANY($1::uuid[]) AND ($2::text[] IS NULL OR project_slug = ANY($2))`,
        [rest, allowed],
      )
    ).rows.map((idea) => [idea.id, idea]),
  );
  return rest.map((id) => {
    const idea = found.get(id);
    return idea
      ? { id, title: idea.title, status: idea.status, reason: 'nicht möglich' }
      : { id, title: null, status: null, reason: 'nicht gefunden' };
  });
}
