import type { Express } from 'express';
import type { Pool } from 'pg';
import { DEVELOPMENT_STATUSES, DEVELOPMENT_STATUS, IDEATION_STATUS } from '../core/status.js';
import { relatedResourceBelongsToProject } from './resource.js';
import { IDEA_FIELDS } from './ideation.js';
import {
  buildUpdate,
  isRecord,
  isUuid,
  PRIORITIES,
  parseFields,
  parseNullableUuid,
  parseOption,
  parseProjectSlug,
  validStatus,
  validText,
} from '../core/validation.js';

export const DEV_COLUMNS = `id, ideation_id AS "ideationId", test_run_id AS "testRunId", sprint_id AS "sprintId",
  title, description, status, priority, created_at AS "createdAt",
  effort_hours AS "effortHours", token_estimate AS "tokenEstimate", benefit, cost,
  kind, bug_id AS "bugId", completed_at AS "completedAt", agent_id AS "agentId", risks, project_context AS "projectContext",
  retry_count AS "retryCount", analysis_status AS "analysisStatus", analysis,
  failure, failure_bug_id AS "failureBugId",
  (SELECT f.status FROM development_items f WHERE f.bug_id = failure_bug_id ORDER BY f.created_at DESC LIMIT 1) AS "fixStatus"`;

const DEV_FIELDS = {
  ...IDEA_FIELDS,
  status: { column: 'status', parse: parseOption(DEVELOPMENT_STATUSES) },
  sprintId: { column: 'sprint_id', parse: parseNullableUuid },
  agentId: { column: 'agent_id', parse: parseNullableUuid },
};

export function registerDevelopmentRoutes(app: Express, pool: Pool): void {
  // Turns an idea into a backlog order; sprint or agent are assigned to the order afterwards.
  app.post('/api/ideation/:id/promote', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(400).json({ message: 'Invalid idea.' });
      return;
    }
    const result = await pool.query(
      `INSERT INTO development_items (project_slug, ideation_id, title, description, status, priority,
                                      effort_hours, token_estimate, benefit, cost)
       SELECT i.project_slug, i.id, i.title, i.description, '${DEVELOPMENT_STATUS.backlog}', i.priority,
              i.effort_hours, i.token_estimate, i.benefit, i.cost
         FROM ideation_items i
        WHERE i.id = $1
          AND NOT EXISTS (SELECT 1 FROM development_items d WHERE d.ideation_id = i.id)
       RETURNING ${DEV_COLUMNS}`,
      [request.params.id],
    );
    if (!result.rows[0]) {
      response.status(409).json({ message: 'Idee nicht gefunden oder bereits als Auftrag übernommen.' });
      return;
    }
    await pool.query(
      `UPDATE ideation_items SET status = '${IDEATION_STATUS.accepted}', updated_at = NOW() WHERE id = $1`,
      [request.params.id],
    );
    response.status(201).json({ item: result.rows[0] });
  });

  app.post('/api/projects/:slug/development', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    const body = request.body as unknown;
    if (
      !slug ||
      !isRecord(body) ||
      !validText(body.title, 180) ||
      (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 10_000)) ||
      (body.status !== undefined && !validStatus(body.status, DEVELOPMENT_STATUSES)) ||
      (body.priority !== undefined && !validStatus(body.priority, PRIORITIES)) ||
      (body.ideationId !== undefined && !isUuid(body.ideationId)) ||
      (body.testRunId !== undefined && !isUuid(body.testRunId))
    ) {
      response.status(400).json({ message: 'Invalid development item.' });
      return;
    }
    const result = await pool.query(
      `INSERT INTO development_items (project_slug, ideation_id, test_run_id, title, description, status, priority)
       SELECT $1, i.id, tr.id, $4, $5, COALESCE($6, '${DEVELOPMENT_STATUS.backlog}'), COALESCE($7, 'medium')
         FROM (SELECT 1) seed
         LEFT JOIN ideation_items i ON i.id = $2 AND i.project_slug = $1
         LEFT JOIN test_runs tr ON tr.id = $3 AND tr.project_slug = $1
        WHERE ($2::uuid IS NULL OR i.id IS NOT NULL)
          AND ($3::uuid IS NULL OR tr.id IS NOT NULL)
       RETURNING ${DEV_COLUMNS}`,
      [
        slug,
        body.ideationId ?? null,
        body.testRunId ?? null,
        body.title.trim(),
        typeof body.description === 'string' ? body.description.trim() : '',
        body.status ?? null,
        body.priority ?? null,
      ],
    );
    if (!result.rows[0]) {
      response.status(400).json({ message: 'Linked ideation or test run does not belong to this project.' });
      return;
    }
    response.status(201).json({ item: result.rows[0] });
  });

  // Retry a blocked order by planning it, using the project's active sprint when no sprint is assigned.
  app.post('/api/development/:id/retry', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Development item not found.' });
      return;
    }
    const result = await pool.query(
      `UPDATE development_items d SET status = '${DEVELOPMENT_STATUS.planned}', auto_run = TRUE, failure = NULL, retry_count = retry_count + 1, analysis_status = CASE WHEN analysis_status IN ('requested', 'running') THEN analysis_status ELSE NULL END,
              sprint_id = COALESCE(d.sprint_id, (SELECT id FROM sprints WHERE project_slug = d.project_slug AND status = 'active' ORDER BY created_at LIMIT 1)),
              updated_at = NOW()
        WHERE d.id = $1 AND d.status = '${DEVELOPMENT_STATUS.blocked}' RETURNING ${DEV_COLUMNS}`,
      [request.params.id],
    );
    if (!result.rows[0]) {
      response.status(409).json({ message: 'Nur blockierte Aufträge können erneut versucht werden.' });
      return;
    }
    response.json({ item: result.rows[0] });
  });

  // Ask the troubleshooter to analyze a blocked order and record the findings as a bug.
  app.post('/api/development/:id/analyze', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Development item not found.' });
      return;
    }
    const result = await pool.query(
      `UPDATE development_items SET analysis_status = 'requested', updated_at = NOW()
        WHERE id = $1 AND status = '${DEVELOPMENT_STATUS.blocked}' AND COALESCE(analysis_status, 'done') NOT IN ('requested', 'running') RETURNING ${DEV_COLUMNS}`,
      [request.params.id],
    );
    if (!result.rows[0]) {
      response.status(409).json({ message: 'Der Auftrag ist nicht blockiert oder wird bereits analysiert.' });
      return;
    }
    response.json({ item: result.rows[0] });
  });

  app.patch('/api/development/:id', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    const fields = parseFields(request.body, DEV_FIELDS);
    if (!fields) {
      response.status(400).json({ message: 'Invalid development update.' });
      return;
    }
    const sprintId = fields.find((field) => field.column === 'sprint_id')?.value;
    if (typeof sprintId === 'string') {
      const sameProject = await relatedResourceBelongsToProject(pool, 'development_items', sprintId, request.params.id);
      if (!sameProject) {
        response.status(400).json({ message: 'Sprint does not belong to the project of this item.' });
        return;
      }
    }
    const agentId = fields.find((field) => field.column === 'agent_id')?.value;
    if (typeof agentId === 'string') {
      if (!(await pool.query(`SELECT 1 FROM development_items WHERE id = $1`, [request.params.id])).rows[0]) {
        response.status(404).json({ message: 'Development item not found.' });
        return;
      }
      const sameProject = await pool.query(
        `SELECT 1 FROM agents a JOIN development_items d ON d.project_slug = a.project_slug
          WHERE a.id = $1 AND d.id = $2`,
        [agentId, request.params.id],
      );
      if (!sameProject.rows[0]) {
        response.status(400).json({ message: 'Agent does not belong to the project of this item.' });
        return;
      }
    }
    const sprintField = fields.find((field) => field.column === 'sprint_id');
    const agentField = fields.find((field) => field.column === 'agent_id');
    const update = buildUpdate(
      'development_items',
      request.params.id,
      fields,
      `${DEV_COLUMNS}, project_slug AS "projectSlug"`,
    );
    const manualStart = typeof agentId === 'string' && !fields.some((field) => field.column === 'status');
    if ((sprintField || agentField) && !manualStart && !fields.some((field) => field.column === 'status')) {
      // Assigning a backlog order to a sprint or an agent plans it; removing both returns it to the backlog.
      const assigned = (sprintField ?? agentField)?.value !== null;
      update.sql = update.sql.replace(
        ', updated_at = NOW()',
        `, status = CASE WHEN status IN ('backlog', 'planned') THEN ${assigned ? "'planned'" : `CASE WHEN ${sprintField ? 'agent_id' : 'sprint_id'} IS NULL THEN 'backlog' ELSE 'planned' END`} ELSE status END, updated_at = NOW()`,
      );
    }
    if (manualStart) {
      // A manual run of one agent restores the previous status after completion, even for done or blocked orders.
      update.sql = update.sql.replace(
        ', updated_at = NOW()',
        `, return_status = CASE WHEN status IN ('backlog', 'blocked', 'done') THEN COALESCE(return_status, status) ELSE return_status END,
          status = CASE WHEN status IN ('backlog', 'blocked', 'done') THEN 'planned' ELSE status END, updated_at = NOW()`,
      );
    }
    const result = await pool.query(update.sql, update.values);
    if (!result.rows[0]) {
      response.status(404).json({ message: 'Development item not found.' });
      return;
    }
    response.json({ item: result.rows[0] });
  });
}
