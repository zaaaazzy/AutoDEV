import { logged } from '../core/log.js';
import { setActionTodo } from '../runner/action-todo.js';
import type { Router } from 'express';
import type { Pool } from 'pg';
import { DEVELOPMENT_STATUSES, DEVELOPMENT_STATUS, IDEATION_STATUS } from '../core/status.js';
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
  CATEGORIES,
  validText,
  TITLE_MAX,
} from '../core/validation.js';

/**
 * Spalten eines Auftrags. fixStatus: Die innere Tabelle ist auf bug_id/status/created_at beschränkt, damit
 * failure_bug_id die Spalte der äusseren Zeile meint – mit vollem Alias löste Postgres sie auf die innere auf.
 * Funktioniert so mit und ohne Alias der äusseren Abfrage (z. B. `UPDATE development_items d … RETURNING`).
 */
export const DEV_COLUMNS = `id, ideation_id AS "ideationId", test_run_id AS "testRunId", sprint_id AS "sprintId",
  title, description, status, priority, created_at AS "createdAt",
  effort_hours AS "effortHours", token_estimate AS "tokenEstimate", benefit, cost,
  kind, category, bug_id AS "bugId", completed_at AS "completedAt", agent_id AS "agentId", risks, project_context AS "projectContext",
  retry_count AS "retryCount", analysis_status AS "analysisStatus", analysis,
  failure, failure_bug_id AS "failureBugId", action_todo AS "actionTodo",
  follow_up_of AS "followUpOf",
  (SELECT f.status FROM (SELECT bug_id, status, created_at FROM development_items) f
    WHERE f.bug_id = failure_bug_id ORDER BY f.created_at DESC LIMIT 1) AS "fixStatus",
  removed_from_sprint AS "removedFromSprint", removed_from_sprint_at AS "removedFromSprintAt",
  sprint_rank AS "sprintRank", review_branch AS "reviewBranch", review_since AS "reviewSince",
  review_approved_at AS "reviewApprovedAt", visual_approved_at AS "visualApprovedAt",
  visual_approved_by AS "visualApprovedBy", changed_files AS "changedFiles"`;

const DEV_FIELDS = {
  ...IDEA_FIELDS,
  status: { column: 'status', parse: parseOption(DEVELOPMENT_STATUSES) },
  sprintId: { column: 'sprint_id', parse: parseNullableUuid },
  agentId: { column: 'agent_id', parse: parseNullableUuid },
};

/**
 * Erlaubte manuelle Statuswechsel per PATCH. `in_progress`, `approval` und `done` setzt nur der Worker (Agent-Lauf,
 * Tester, Review, Merge); einen laufenden oder fertigen Auftrag ändert die Oberfläche über eigene Routen
 * (Erneut versuchen, Freigeben, Ablehnen, aus dem Sprint nehmen).
 */
const MANUAL_DEVELOPMENT_TRANSITIONS: Record<string, readonly string[]> = {
  [DEVELOPMENT_STATUS.backlog]: [DEVELOPMENT_STATUS.planned, DEVELOPMENT_STATUS.rejected],
  [DEVELOPMENT_STATUS.planned]: [DEVELOPMENT_STATUS.backlog, DEVELOPMENT_STATUS.rejected],
  [DEVELOPMENT_STATUS.blocked]: [DEVELOPMENT_STATUS.planned, DEVELOPMENT_STATUS.backlog, DEVELOPMENT_STATUS.rejected],
  [DEVELOPMENT_STATUS.rejected]: [DEVELOPMENT_STATUS.backlog, DEVELOPMENT_STATUS.planned],
};
/** Aufträge lassen sich nur Sprints zuordnen, die noch laufen können. */
const ASSIGNABLE_SPRINT_STATUSES = new Set(['planned', 'active']);

/** Kommentar beim erneuten Versuch: geht als Hinweis an die Agents (wird an die Beschreibung angehängt). */
export function retryComment(body: unknown): string | null {
  const raw = isRecord(body) && typeof body.comment === 'string' ? body.comment.trim() : '';
  return raw ? raw.slice(0, 2000) : null;
}

export function registerDevelopmentRoutes(app: Router, pool: Pool): void {
  // Turns an idea into a backlog order; sprint or agent are assigned to the order afterwards.
  app.post('/ideation/:id/promote', async (request, response) => {
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

  app.post('/projects/:slug/development', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    const body = request.body as unknown;
    if (
      !slug ||
      !isRecord(body) ||
      !validText(body.title, TITLE_MAX) ||
      (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 10_000)) ||
      (body.status !== undefined && !validStatus(body.status, DEVELOPMENT_STATUSES)) ||
      (body.priority !== undefined && !validStatus(body.priority, PRIORITIES)) ||
      (body.ideationId !== undefined && !isUuid(body.ideationId)) ||
      (body.testRunId !== undefined && !isUuid(body.testRunId)) ||
      (body.category !== undefined &&
        body.category !== null &&
        body.category !== '' &&
        !validStatus(body.category, CATEGORIES))
    ) {
      response.status(400).json({ message: 'Invalid development item.' });
      return;
    }
    const result = await pool.query(
      `INSERT INTO development_items (project_slug, ideation_id, test_run_id, title, description, status, priority,
                                      category)
       SELECT $1, i.id, tr.id, $4, $5, COALESCE($6, '${DEVELOPMENT_STATUS.backlog}'), COALESCE($7, 'medium'), $8
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
        body.category || null,
      ],
    );
    if (!result.rows[0]) {
      response.status(400).json({ message: 'Linked ideation or test run does not belong to this project.' });
      return;
    }
    response.status(201).json({ item: result.rows[0] });
  });

  // Folgeauftrag zu einem erledigten Auftrag: neuer Auftrag mit Bezug, optional gleich in einem Sprint eingeplant.
  app.post('/development/:id/follow-up', async (request, response) => {
    const body = request.body as unknown;
    if (
      !isUuid(request.params.id) ||
      !isRecord(body) ||
      !validText(body.title, TITLE_MAX) ||
      (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 10_000)) ||
      (body.priority !== undefined && !validStatus(body.priority, PRIORITIES)) ||
      (body.sprintId !== undefined && body.sprintId !== null && !isUuid(body.sprintId))
    ) {
      response.status(400).json({ message: `Titel (max. ${TITLE_MAX} Zeichen) und Beschreibung prüfen.` });
      return;
    }
    const source = (
      await pool.query<{ projectSlug: string; status: string; category: string | null }>(
        `SELECT project_slug AS "projectSlug", status, category FROM development_items WHERE id = $1`,
        [request.params.id],
      )
    ).rows[0];
    if (!source) return void response.status(404).json({ message: 'Auftrag nicht gefunden.' });
    if (source.status !== DEVELOPMENT_STATUS.done) {
      response.status(400).json({ message: 'Ein Folgeauftrag bezieht sich auf einen erledigten Auftrag.' });
      return;
    }
    const sprintId = typeof body.sprintId === 'string' ? body.sprintId : null;
    if (
      sprintId &&
      !(await pool.query('SELECT 1 FROM sprints WHERE id = $1 AND project_slug = $2', [sprintId, source.projectSlug]))
        .rows[0]
    ) {
      response.status(400).json({ message: 'Sprint gehört nicht zum Projekt.' });
      return;
    }
    const result = await pool.query(
      `INSERT INTO development_items (project_slug, title, description, status, priority, category, sprint_id, follow_up_of)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'medium'), $6, $7, $8)
       RETURNING ${DEV_COLUMNS}`,
      [
        source.projectSlug,
        body.title.trim(),
        typeof body.description === 'string' ? body.description.trim() : '',
        sprintId ? DEVELOPMENT_STATUS.planned : DEVELOPMENT_STATUS.backlog,
        body.priority ?? null,
        source.category,
        sprintId,
        request.params.id,
      ],
    );
    response.status(201).json({ item: result.rows[0] });
  });

  // Retry a blocked or (after adjusting) rejected order, using the project's active sprint when none is assigned.
  app.post('/development/:id/retry', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Development item not found.' });
      return;
    }
    const comment = retryComment(request.body);
    const result = await pool.query(
      `UPDATE development_items d SET status = '${DEVELOPMENT_STATUS.planned}', auto_run = TRUE, failure = NULL, action_todo = NULL,
              description = CASE WHEN $2::text IS NULL THEN d.description
                                 ELSE COALESCE(d.description, '') || E'\n\n## Hinweis zum erneuten Versuch (' || to_char(NOW(), 'DD.MM.YYYY HH24:MI') || E')\n' || $2::text END,
              retry_count = retry_count + CASE WHEN d.status = '${DEVELOPMENT_STATUS.blocked}' THEN 1 ELSE 0 END,
              analysis_status = CASE WHEN analysis_status IN ('requested', 'running') THEN analysis_status ELSE NULL END,
              sprint_id = COALESCE(d.sprint_id, (SELECT id FROM sprints WHERE project_slug = d.project_slug AND status = 'active' ORDER BY created_at LIMIT 1)),
              removed_from_sprint = NULL, removed_from_sprint_at = NULL, budget_since = NOW(), updated_at = NOW()
        WHERE d.id = $1 AND d.kind <> 'express' AND (d.status IN ('${DEVELOPMENT_STATUS.blocked}', '${DEVELOPMENT_STATUS.rejected}')
              OR (d.removed_from_sprint_at IS NOT NULL AND d.status IN ('${DEVELOPMENT_STATUS.backlog}', '${DEVELOPMENT_STATUS.planned}')))
        RETURNING ${DEV_COLUMNS}`,
      [request.params.id, comment],
    );
    if (!result.rows[0]) {
      response.status(409).json({
        message:
          'Nur blockierte, abgelehnte oder aus dem Sprint entfernte Aufträge können weiterbearbeitet werden. Express-Anfragen gehen im Dashboard-Chat weiter.',
      });
      return;
    }
    response.json({ item: result.rows[0] });
  });

  // Aus dem Sprint nehmen: Der Auftrag wartet danach unter „Aktionen“ auf eine Entscheidung.
  app.post('/development/:id/remove-from-sprint', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Development item not found.' });
      return;
    }
    const result = await pool.query(
      `UPDATE development_items SET removed_from_sprint = (SELECT name FROM sprints WHERE id = development_items.sprint_id),
              removed_from_sprint_at = NOW(), sprint_id = NULL, agent_id = NULL, auto_run = FALSE,
              status = CASE WHEN status = '${DEVELOPMENT_STATUS.planned}' THEN '${DEVELOPMENT_STATUS.backlog}' ELSE status END,
              updated_at = NOW()
        WHERE id = $1 AND sprint_id IS NOT NULL
          AND status NOT IN ('${DEVELOPMENT_STATUS.inProgress}', '${DEVELOPMENT_STATUS.done}')
        RETURNING ${DEV_COLUMNS}`,
      [request.params.id],
    );
    if (!result.rows[0]) {
      response
        .status(409)
        .json({ message: 'Nur geplante oder blockierte Aufträge eines Sprints lassen sich herausnehmen.' });
      return;
    }
    response.json({ item: result.rows[0] });
  });

  // Endgültig löschen (nicht, solange Agents daran arbeiten); Läufe und Abnahme werden mitgelöscht.
  app.delete('/development/:id', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Development item not found.' });
      return;
    }
    const result = await pool.query(
      `DELETE FROM development_items WHERE id = $1 AND status <> '${DEVELOPMENT_STATUS.inProgress}'
       RETURNING id, ideation_id AS "ideationId"`,
      [request.params.id],
    );
    if (!result.rows[0]) {
      response.status(409).json({ message: 'Der Auftrag läuft gerade und kann nicht gelöscht werden.' });
      return;
    }
    // Ohne Auftrag ist die Idee wieder offen (sonst hinge sie dauerhaft auf „Auftrag wird bearbeitet“).
    if (result.rows[0].ideationId) {
      await pool.query(
        `UPDATE ideation_items SET status = '${IDEATION_STATUS.idea}', updated_at = NOW()
          WHERE id = $1 AND status = '${IDEATION_STATUS.accepted}'
            AND NOT EXISTS (SELECT 1 FROM development_items WHERE ideation_id = $1)`,
        [result.rows[0].ideationId],
      );
    }
    response.status(204).end();
  });

  // Rückfragen beantworten: Punkte, die der Tester „von dir zu prüfen“ gemeldet hat, als geprüft bestätigen.
  app.post('/development/:id/acceptance/confirm', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Development item not found.' });
      return;
    }
    const result = await pool.query(
      `UPDATE acceptance_checks SET status = 'met', note = TRIM(note || ' (von dir bestätigt)'), checked_at = NOW()
        WHERE development_id = $1 AND status = 'manual'`,
      [request.params.id],
    );
    // Alle manuellen Punkte bestätigt: nichts mehr zu tun (Sprintbericht wird aktualisiert).
    await setActionTodo(pool, request.params.id, null).catch(logged('development'));
    response.json({ confirmed: result.rowCount ?? 0 });
  });

  // Ask the troubleshooter to analyze a blocked order and record the findings as a bug.
  app.post('/development/:id/analyze', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Development item not found.' });
      return;
    }
    const result = await pool.query(
      `UPDATE development_items SET analysis_status = 'requested', updated_at = NOW()
        WHERE id = $1 AND status = '${DEVELOPMENT_STATUS.blocked}' AND kind <> 'express'
          AND COALESCE(analysis_status, 'done') NOT IN ('requested', 'running') RETURNING ${DEV_COLUMNS}`,
      [request.params.id],
    );
    if (!result.rows[0]) {
      response.status(409).json({ message: 'Der Auftrag ist nicht blockiert oder wird bereits analysiert.' });
      return;
    }
    response.json({ item: result.rows[0] });
  });

  app.patch('/development/:id', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    const fields = parseFields(request.body, DEV_FIELDS);
    if (!fields) {
      response.status(400).json({ message: 'Invalid development update.' });
      return;
    }
    const target = fields.find((field) => field.column === 'status')?.value as string | undefined;
    let from: string | undefined;
    if (target) {
      const current = await pool.query<{ status: string }>(`SELECT status FROM development_items WHERE id = $1`, [
        request.params.id,
      ]);
      from = current.rows[0]?.status;
      if (!from) {
        response.status(404).json({ message: 'Development item not found.' });
        return;
      }
      if (from !== target && !MANUAL_DEVELOPMENT_TRANSITIONS[from]?.includes(target)) {
        response.status(409).json({
          message: `Status change ${from} → ${target} is not allowed manually; it is set by the worker or a dedicated action.`,
        });
        return;
      }
    }
    const sprintId = fields.find((field) => field.column === 'sprint_id')?.value;
    if (typeof sprintId === 'string') {
      const sprint = await pool.query<{ sprintStatus: string }>(
        `SELECT s.status AS "sprintStatus" FROM sprints s JOIN development_items e ON e.project_slug = s.project_slug
          WHERE s.id = $1 AND e.id = $2`,
        [sprintId, request.params.id],
      );
      if (!sprint.rows[0]) {
        response.status(400).json({ message: 'Sprint does not belong to the project of this item.' });
        return;
      }
      if (!ASSIGNABLE_SPRINT_STATUSES.has(sprint.rows[0].sprintStatus)) {
        response.status(409).json({ message: 'Orders can only be assigned to planned or active sprints.' });
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
    // Status nur ändern, wenn er seit der Prüfung gleich geblieben ist (kein Wettlauf mit dem Worker).
    const update = buildUpdate(
      'development_items',
      request.params.id,
      fields,
      `${DEV_COLUMNS}, project_slug AS "projectSlug"`,
      from ? { column: 'status', values: [from] } : undefined,
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
    if (sprintField && sprintField.value !== null) {
      // Wieder einem Sprint zugeordnet: nicht mehr „aus dem Sprint entfernt“.
      update.sql = update.sql.replace(
        ', updated_at = NOW()',
        ', removed_from_sprint = NULL, removed_from_sprint_at = NULL, updated_at = NOW()',
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
      response.status(from ? 409 : 404).json({
        message: from ? 'The order has changed in the meantime – please reload.' : 'Development item not found.',
      });
      return;
    }
    response.json({ item: result.rows[0] });
  });
}
