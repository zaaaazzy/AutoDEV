import { logged } from '../core/log.js';
import { setActionTodo } from '../runner/action-todo.js';
import type { Request, Response, Router } from 'express';
import type { Pool } from 'pg';
import { DEVELOPMENT_STATUS } from '../core/status.js';
import {
  canSetDevelopmentStatus,
  isAssignableSprintStatus,
  isSprintLockedDevelopmentStatus,
} from '../core/development-transitions.js';
import {
  agentInOrderProject,
  confirmManualAcceptance,
  deleteOrder,
  findOrderSprintStatus,
  findOrderState,
  findOrderSummary,
  findProjectSprintStatus,
  insertFollowUp,
  insertOrder,
  isAbortedOrder,
  orderExists,
  promoteIdea,
  removeFromSprint,
  requestAnalysis,
  retryOrder,
  sprintAcceptsOrder,
  takeIntoSprint,
  updateOrder,
} from '../db/development-repository.js';
import { access } from './access.js';
import {
  DEV_FIELDS,
  INVALID_FOLLOW_UP,
  parseFollowUp,
  parseNewOrder,
  parseOptionalSprintId,
  retryComment,
} from './development-input.js';
import { developmentPatchRole, hasRole, ROLE_INFO, type Principal } from './roles.js';
import {
  invalidInput,
  isRecord,
  isUuid,
  manualEstimateSql,
  parseFields,
  parseProjectSlug,
} from '../core/validation.js';

/** Status, die ein manueller Einzellauf vorübergehend verlässt und danach wiederherstellt. */
const RETURNABLE_SQL = [DEVELOPMENT_STATUS.backlog, DEVELOPMENT_STATUS.blocked, DEVELOPMENT_STATUS.done]
  .map((status) => `'${status}'`)
  .join(', ');

// Bisherige Importpfade (board, review-routes, Tests) bleiben gültig.
export { DEV_COLUMNS, retryAutoRunSql, retrySprintSql } from '../db/development-repository.js';
export { retryComment } from './development-input.js';

/** Pfad-Parameter wie bei inline registrierten Routen: einzelne Strings (:id, :slug). */
type PathRequest = Request<Record<string, string>>;
type Handler = (request: PathRequest, response: Response) => Promise<void>;

const ORDER_NOT_FOUND = { message: 'Auftrag nicht gefunden.' };

/**
 * Zusätzliche SET-Zuweisungen für PATCH /development/:id (als `extra` an `buildUpdate`). Jede Spalte erscheint
 * höchstens einmal; `targetSprintStatus` ist der Status eines neu gewählten Sprints.
 */
export function developmentUpdateExtras(
  fields: { column: string; value: unknown }[],
  targetSprintStatus?: string,
): string[] {
  const extras = manualEstimateSql(fields);
  const sprintField = fields.find((field) => field.column === 'sprint_id');
  const agentField = fields.find((field) => field.column === 'agent_id');
  const statusGiven = fields.some((field) => field.column === 'status');
  const manualStart = typeof agentField?.value === 'string' && !statusGiven;
  if ((sprintField || agentField) && !manualStart && !statusGiven) {
    // Assigning a backlog order to a sprint or an agent plans it; removing both returns it to the backlog.
    const assigned = (sprintField ?? agentField)?.value !== null;
    const target = assigned
      ? `'${DEVELOPMENT_STATUS.planned}'`
      : `CASE WHEN ${sprintField ? 'agent_id' : 'sprint_id'} IS NULL THEN '${DEVELOPMENT_STATUS.backlog}' ELSE '${DEVELOPMENT_STATUS.planned}' END`;
    extras.push(
      `status = CASE WHEN status IN ('${DEVELOPMENT_STATUS.backlog}', '${DEVELOPMENT_STATUS.planned}') THEN ${target} ELSE status END`,
    );
  }
  if (sprintField && sprintField.value !== null) {
    // Wieder einem Sprint zugeordnet: nicht mehr „aus dem Sprint entfernt“.
    extras.push('removed_from_sprint = NULL', 'removed_from_sprint_at = NULL');
  }
  if (targetSprintStatus && targetSprintStatus !== 'active') {
    // Ein geplanter Sprint startet seine Aufträge selbst; ein altes auto_run (z. B. von /retry) liesse den Worker
    // den Auftrag sonst sofort starten (selectItems nimmt auto_run unabhängig vom Sprint-Status).
    extras.push('auto_run = FALSE');
  }
  if (manualStart) {
    // A manual run of one agent restores the previous status after completion, even for done or blocked orders.
    extras.push(
      `return_status = CASE WHEN status IN (${RETURNABLE_SQL}) THEN COALESCE(return_status, status) ELSE return_status END`,
      `status = CASE WHEN status IN (${RETURNABLE_SQL}) THEN '${DEVELOPMENT_STATUS.planned}' ELSE status END`,
    );
  }
  return extras;
}

/** Auftrags-ID aus dem Pfad; bei ungültiger ID ist die Antwort (404) schon gesendet. */
function orderId(request: PathRequest, response: Response, notFound = ORDER_NOT_FOUND): string | null {
  const id = request.params.id;
  if (isUuid(id)) return id;
  response.status(404).json(notFound);
  return null;
}

// Turns an idea into a backlog order; sprint or agent are assigned to the order afterwards.
const promote =
  (pool: Pool): Handler =>
  async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(400).json({ message: 'Ungültige Idee.' });
      return;
    }
    const item = await promoteIdea(pool, request.params.id);
    if (!item) {
      response.status(409).json({ message: 'Idee nicht gefunden oder bereits als Auftrag übernommen.' });
      return;
    }
    response.status(201).json({ item });
  };

const createOrder =
  (pool: Pool): Handler =>
  async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Ungültiges Projekt.' });
      return;
    }
    const input = parseNewOrder(request.body);
    if (!input.ok) {
      response.status(400).json(input.error);
      return;
    }
    const item = await insertOrder(pool, slug, input.value);
    // Je Idee höchstens ein Auftrag (Unique-Index auf ideation_id).
    if (item === 'duplicate') {
      response.status(409).json({ field: 'ideationId', message: 'Zu dieser Idee gibt es schon einen Auftrag.' });
      return;
    }
    if (item === 'foreign') {
      response.status(400).json({ message: 'Die verknüpfte Idee oder der Testlauf gehört nicht zu diesem Projekt.' });
      return;
    }
    response.status(201).json({ item });
  };

// Folgeauftrag zu einem erledigten Auftrag: neuer Auftrag mit Bezug, optional gleich in einem Sprint eingeplant.
const createFollowUp =
  (pool: Pool): Handler =>
  async (request, response) => {
    const id = request.params.id;
    const input = parseFollowUp(request.body);
    if (!isUuid(id) || !input.ok) {
      response.status(400).json(INVALID_FOLLOW_UP);
      return;
    }
    const { title, description, priority, sprintId } = input.value;
    const source = await findOrderSummary(pool, id);
    if (!source) return void response.status(404).json(ORDER_NOT_FOUND);
    if (source.status !== DEVELOPMENT_STATUS.done) {
      response.status(400).json({ message: 'Ein Folgeauftrag bezieht sich auf einen erledigten Auftrag.' });
      return;
    }
    const sprintStatus = sprintId ? await findProjectSprintStatus(pool, sprintId, source.projectSlug) : undefined;
    if (sprintId && !sprintStatus) {
      response.status(400).json({ message: 'Sprint gehört nicht zum Projekt.' });
      return;
    }
    // Wie beim Zuordnen per PATCH: nur in geplante oder aktive Sprints, nicht in abgeschlossene oder solche im Review.
    if (sprintStatus && !isAssignableSprintStatus(sprintStatus)) {
      response.status(409).json({ message: 'Folgeaufträge nur in geplante oder aktive Sprints.' });
      return;
    }
    const item = await insertFollowUp(pool, {
      projectSlug: source.projectSlug,
      title,
      description,
      priority,
      category: source.category,
      sprintId,
      followUpOf: id,
    });
    response.status(201).json({ item });
  };

/**
 * Retry a blocked or (after adjusting) rejected order. Optional `sprintId` (geplant oder aktiv, gleiches Projekt):
 * Status und Sprint in einem UPDATE, ohne Zwischenstand im aktiven Sprint. Ohne Wahl siehe retrySprintSql.
 */
const retry =
  (pool: Pool): Handler =>
  async (request, response) => {
    const id = orderId(request, response);
    if (!id) return;
    const sprintId = parseOptionalSprintId(request.body);
    if (sprintId === undefined) {
      response.status(400).json({ message: 'Ungültiger Sprint.' });
      return;
    }
    const item = await retryOrder(pool, id, retryComment(request.body), sprintId);
    // Nur für die Meldung: lag es am Sprint oder am Auftrag?
    if (!item && sprintId && !(await sprintAcceptsOrder(pool, id, sprintId))) {
      response
        .status(409)
        .json({ message: 'Erneut versuchen nur in geplante oder aktive Sprints desselben Projekts.' });
      return;
    }
    if (!item) {
      response.status(409).json({
        message:
          'Nur blockierte, abgelehnte oder aus dem Sprint entfernte Aufträge können weiterbearbeitet werden. Express-Anfragen gehen im Dashboard-Chat weiter.',
      });
      return;
    }
    response.json({ item });
  };

/**
 * In einen Sprint übernehmen (Sprintseite „Aufträge hinzufügen“): offene und abgebrochene Aufträge in einer Abfrage.
 * Abgebrochene (aus einem Sprint genommen oder blockiert) werden dabei wie bei /retry zurückgesetzt, landen aber direkt
 * im Ziel-Sprint statt erst im aktiven. auto_run nur, wenn der Ziel-Sprint läuft – ein geplanter wartet auf seinen Start.
 * Abgebrochene neu einplanen ist ein erneuter Versuch: dafür braucht es wie bei /retry zusätzlich „Ausführen“ (403).
 */
const takeInto =
  (pool: Pool): Handler =>
  async (request, response) => {
    const id = orderId(request, response);
    if (!id) return;
    const sprintId = isRecord(request.body) ? request.body.sprintId : undefined;
    if (!isUuid(sprintId)) {
      response.status(400).json({ message: 'Sprint fehlt oder ist ungültig.' });
      return;
    }
    const canRun = hasRole(response.locals.principal as Principal | undefined, 'run');
    const item = await takeIntoSprint(pool, id, sprintId, canRun);
    // Nur für die Meldung: lag es am fehlenden Recht?
    if (!item && !canRun && (await isAbortedOrder(pool, id))) {
      response.status(403).json({
        message: `Abgebrochene Aufträge neu einplanen braucht die Rolle „${ROLE_INFO.run.label}“.`,
      });
      return;
    }
    if (!item) {
      response.status(409).json({
        message:
          'Nur offene oder abgebrochene Aufträge ohne Sprint lassen sich übernehmen, und nur in geplante oder aktive Sprints desselben Projekts.',
      });
      return;
    }
    response.json({ item });
  };

// Aus dem Sprint nehmen: Der Auftrag wartet danach unter „Aktionen“ auf eine Entscheidung.
const removeFrom =
  (pool: Pool): Handler =>
  async (request, response) => {
    const id = orderId(request, response);
    if (!id) return;
    const item = await removeFromSprint(pool, id);
    if (!item) {
      response.status(409).json({
        message:
          'Nur geplante oder blockierte Aufträge lassen sich herausnehmen, und nur aus geplanten oder aktiven Sprints.',
      });
      return;
    }
    response.json({ item });
  };

// Endgültig löschen (nicht, solange Agents daran arbeiten); Läufe und Abnahme werden mitgelöscht.
const remove =
  (pool: Pool): Handler =>
  async (request, response) => {
    const id = orderId(request, response);
    if (!id) return;
    if (!(await deleteOrder(pool, id))) {
      response.status(409).json({ message: 'Der Auftrag läuft gerade und kann nicht gelöscht werden.' });
      return;
    }
    response.status(204).end();
  };

// Rückfragen beantworten: Punkte, die der Tester „von dir zu prüfen“ gemeldet hat, als geprüft bestätigen.
const confirmAcceptance =
  (pool: Pool): Handler =>
  async (request, response) => {
    const id = orderId(request, response);
    if (!id) return;
    const confirmed = await confirmManualAcceptance(pool, id);
    // Alle manuellen Punkte bestätigt: nichts mehr zu tun (Sprintbericht wird aktualisiert).
    await setActionTodo(pool, id, null).catch(logged('development'));
    response.json({ confirmed });
  };

// Ask the troubleshooter to analyze a blocked order and record the findings as a bug.
const analyze =
  (pool: Pool): Handler =>
  async (request, response) => {
    const id = orderId(request, response);
    if (!id) return;
    const item = await requestAnalysis(pool, id);
    if (!item) {
      response.status(409).json({ message: 'Der Auftrag ist nicht blockiert oder wird bereits analysiert.' });
      return;
    }
    response.json({ item });
  };

const update =
  (pool: Pool): Handler =>
  async (request, response) => {
    const id = orderId(request, response, { message: 'Nicht gefunden.' });
    if (!id) return;
    const fields = parseFields(request.body, DEV_FIELDS);
    if (!fields) {
      response.status(400).json(invalidInput(request.body, DEV_FIELDS));
      return;
    }
    const target = fields.find((field) => field.column === 'status')?.value as string | undefined;
    const sprintChange = fields.find((field) => field.column === 'sprint_id');
    let from: string | undefined;
    let sprintUnchanged = false;
    if (target || sprintChange) {
      const current = await findOrderState(pool, id);
      if (!current) {
        response.status(404).json(ORDER_NOT_FOUND);
        return;
      }
      from = current.status;
      if (target && !canSetDevelopmentStatus(from, target)) {
        response.status(409).json({
          message: `Status change ${from} → ${target} is not allowed manually; it is set by the worker or a dedicated action.`,
        });
        return;
      }
      // Erst der Auftragsstatus, dann der Ziel-Sprint. Derselbe Sprint wie bisher ist keine Änderung (Formular speichert
      // ihn mit), sonst bräche das Speichern anderer Felder bei laufenden Aufträgen.
      sprintUnchanged = sprintChange?.value === (current.sprintId ?? null);
      if (sprintChange && !sprintUnchanged && isSprintLockedDevelopmentStatus(from)) {
        response.status(409).json({
          message: 'Aufträge in Arbeit, in Freigabe oder erledigt lassen sich keinem anderen Sprint zuordnen.',
        });
        return;
      }
    }
    const sprintId = sprintChange?.value;
    let targetSprintStatus: string | undefined;
    // Der bisherige Sprint darf inzwischen im Review oder abgeschlossen sein (wie bei Bugs).
    if (typeof sprintId === 'string' && !sprintUnchanged) {
      targetSprintStatus = await findOrderSprintStatus(pool, sprintId, id);
      if (!targetSprintStatus) {
        response.status(400).json({ message: 'Der Sprint gehört nicht zum Projekt dieses Auftrags.' });
        return;
      }
      if (!isAssignableSprintStatus(targetSprintStatus)) {
        response.status(409).json({ message: 'Aufträge lassen sich nur geplanten oder aktiven Sprints zuordnen.' });
        return;
      }
    }
    const agentId = fields.find((field) => field.column === 'agent_id')?.value;
    if (typeof agentId === 'string') {
      if (!(await orderExists(pool, id))) {
        response.status(404).json(ORDER_NOT_FOUND);
        return;
      }
      if (!(await agentInOrderProject(pool, agentId, id))) {
        response.status(400).json({ message: 'Der Agent gehört nicht zum Projekt dieses Auftrags.' });
        return;
      }
    }
    const item = await updateOrder(pool, id, fields, from, developmentUpdateExtras(fields, targetSprintStatus));
    if (!item) {
      response.status(from ? 409 : 404).json({
        message: from ? 'The order has changed in the meantime – please reload.' : 'Auftrag nicht gefunden.',
      });
      return;
    }
    response.json({ item });
  };

export function registerDevelopmentRoutes(app: Router, pool: Pool): void {
  const plan = { role: 'plan', tenant: 'development' } as const;
  const run = { role: 'run', tenant: 'development' } as const;
  app.post('/ideation/:id/promote', access({ role: 'plan', tenant: 'ideation' }), promote(pool));
  app.post('/projects/:slug/development', access({ role: 'plan', tenant: 'project' }), createOrder(pool));
  app.post('/development/:id/follow-up', access(plan), createFollowUp(pool));
  app.post('/development/:id/retry', access(run), retry(pool));
  app.post('/development/:id/take-into-sprint', access(plan), takeInto(pool));
  app.post('/development/:id/remove-from-sprint', access(plan), removeFrom(pool));
  app.delete('/development/:id', access(plan), remove(pool));
  app.post('/development/:id/acceptance/confirm', access(plan), confirmAcceptance(pool));
  app.post('/development/:id/analyze', access(run), analyze(pool));
  app.patch('/development/:id', access({ role: developmentPatchRole, tenant: 'development' }), update(pool));
}
