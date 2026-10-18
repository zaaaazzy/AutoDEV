import type { Express } from 'express';
import type { Pool } from 'pg';
import { completeSprint } from './sprint-planning.js';
import {
  buildUpdate,
  isRecord,
  isUuid,
  parseFields,
  parseLongText,
  parseNullableDate,
  parseOption,
  parseProjectSlug,
  parseTitle,
} from '../core/validation.js';

const SPRINT_STATUSES = new Set(['planned', 'active', 'completed']);
const SPRINT_COLUMNS = `id, project_slug AS "projectSlug", name, goal, status,
  to_char(start_date, 'YYYY-MM-DD') AS "startDate", to_char(end_date, 'YYYY-MM-DD') AS "endDate",
  created_at AS "createdAt", git_sync AS "gitSync", git_message AS "gitMessage",
  git_commit AS "gitCommit", git_branch AS "gitBranch", git_synced_at AS "gitSyncedAt"`;
const SPRINT_FIELDS = {
  name: { column: 'name', parse: parseTitle(120) },
  goal: { column: 'goal', parse: parseLongText },
  status: { column: 'status', parse: parseOption(SPRINT_STATUSES) },
  startDate: { column: 'start_date', parse: parseNullableDate },
  endDate: { column: 'end_date', parse: parseNullableDate },
};

function databaseCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export function registerSprintRoutes(app: Express, pool: Pool): void {
  app.get('/api/projects/:slug/sprints', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Invalid project slug.' });
      return;
    }
    const result = await pool.query(
      `SELECT ${SPRINT_COLUMNS} FROM sprints WHERE project_slug = $1
        ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, start_date NULLS LAST, created_at`,
      [slug],
    );
    response.json({ sprints: result.rows });
  });

  app.post('/api/projects/:slug/sprints', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    const fields = parseFields(request.body, SPRINT_FIELDS);
    const values = new Map((fields ?? []).map((field) => [field.column, field.value]));
    if (!slug || !fields || !values.get('name') || values.get('status') === 'active') {
      response.status(400).json({ message: 'Invalid sprint.' });
      return;
    }
    try {
      const result = await pool.query(
        `INSERT INTO sprints (project_slug, name, goal, status, start_date, end_date)
         VALUES ($1, $2, $3, COALESCE($4, 'planned'), $5, $6)
         RETURNING ${SPRINT_COLUMNS}`,
        [
          slug,
          values.get('name'),
          values.get('goal') ?? '',
          values.get('status') ?? null,
          values.get('start_date') ?? null,
          values.get('end_date') ?? null,
        ],
      );
      response.status(201).json({ sprint: result.rows[0] });
    } catch (error) {
      if (databaseCode(error) === '23514') {
        response.status(400).json({ message: 'Das Enddatum darf nicht vor dem Startdatum liegen.' });
        return;
      }
      throw error;
    }
  });

  app.patch('/api/sprints/:id', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    const fields = parseFields(request.body, SPRINT_FIELDS);
    if (!fields) {
      response.status(400).json({ message: 'Invalid sprint update.' });
      return;
    }
    const update = buildUpdate('sprints', request.params.id, fields, SPRINT_COLUMNS);
    try {
      const result = await pool.query(update.sql, update.values);
      if (!result.rows[0]) {
        response.status(404).json({ message: 'Sprint not found.' });
        return;
      }
      if (result.rows[0].status === 'completed') {
        // Sprintende: Bericht, dann Sprint-Branch testen, pushen und nach main mergen (übernimmt der Worker).
        await completeSprint(pool, request.params.id);
      }
      response.json({ sprint: result.rows[0] });
    } catch (error) {
      const code = databaseCode(error);
      if (code === '23505') {
        response.status(409).json({ message: 'Es kann nur ein Sprint pro Projekt aktiv sein.' });
        return;
      }
      if (code === '23514') {
        response.status(400).json({ message: 'Das Enddatum darf nicht vor dem Startdatum liegen.' });
        return;
      }
      throw error;
    }
  });

  app.post('/api/sprints/:id/git-sync', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    const action = isRecord(request.body) && request.body.action === 'pull' ? 'pull' : 'push';
    const result = await pool.query(
      `UPDATE sprints SET git_sync = 'pending', git_action = $2, git_message = NULL
        WHERE id = $1 AND (git_sync IS NULL OR git_sync IN ('done', 'failed')) RETURNING ${SPRINT_COLUMNS}`,
      [request.params.id, action],
    );
    if (!result.rows[0]) {
      response.status(409).json({ message: 'Die Git-Sicherung dieses Sprints läuft bereits.' });
      return;
    }
    response.json({ sprint: result.rows[0] });
  });

  // Kanban: Reihenfolge der Aufträge im Sprint festlegen (oberste zuerst).
  app.post('/api/sprints/:id/order', async (request, response, next) => {
    try {
      const ids = (request.body as { ids?: unknown } | undefined)?.ids;
      if (!isUuid(request.params.id) || !Array.isArray(ids) || ids.length > 500 || !ids.every(isUuid)) {
        response.status(400).json({ message: 'Ungültige Reihenfolge.' });
        return;
      }
      await pool.query(
        `UPDATE development_items d SET sprint_rank = o.rank, updated_at = NOW()
           FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, rank)
          WHERE d.id = o.id AND d.sprint_id = $1`,
        [request.params.id, ids],
      );
      response.json({ ordered: ids.length });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/sprints/:id', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    const result = await pool.query('DELETE FROM sprints WHERE id = $1 RETURNING id', [request.params.id]);
    if (!result.rows[0]) {
      response.status(404).json({ message: 'Sprint not found.' });
      return;
    }
    response.status(204).end();
  });
}
