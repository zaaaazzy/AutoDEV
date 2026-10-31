import type { Router } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import type { Principal } from './roles.js';
import { completeSprintIn } from './sprint-planning.js';
import { guardGit } from './git-state.js';
import { sprintBranch } from '../runner/git-sync/git-helpers.js';
import {
  buildUpdate,
  isRecord,
  invalidInput,
  isUuid,
  parseFields,
  parseLongText,
  parseNullableDate,
  parseOption,
  parseProjectSlug,
  parseTitle,
} from '../core/validation.js';
import {
  canChangeSprintStatus,
  completeSprintConflict,
  DELETABLE_SPRINT_STATUSES,
  IDLE_SPRINT_GIT_SYNC,
  ONE_ACTIVE_SPRINT_MESSAGE as ONE_ACTIVE_MESSAGE,
  SPRINT_HOLDING_DEVELOPMENT_STATUSES,
} from '../core/sprint-rules.js';
import { AGENT_RUN_STATUS, AGENT_STEP_STATUS, DEVELOPMENT_STATUS, SPRINT_STATUS } from '../core/status.js';

const SPRINT_STATUSES = new Set(['planned', 'active', 'completed', 'cancelled']);
const SPRINT_COLUMNS = `id, project_slug AS "projectSlug", name, goal, status,
  to_char(start_date, 'YYYY-MM-DD') AS "startDate", to_char(end_date, 'YYYY-MM-DD') AS "endDate",
  created_at AS "createdAt", git_sync AS "gitSync", git_message AS "gitMessage",
  git_commit AS "gitCommit", git_branch AS "gitBranch", git_synced_at AS "gitSyncedAt", pr_url AS "prUrl", ci_status AS "ciStatus",
  review_ready_at AS "reviewReadyAt", paused_at AS "pausedAt", paused_by AS "pausedBy"`;
/** Feste Statuslisten aus sprint-rules für `IN (…)` (eigene Konstanten, keine Benutzereingabe). */
const sqlList = (statuses: readonly string[]): string => statuses.map((status) => `'${status}'`).join(', ');
const SPRINT_FIELDS = {
  name: { column: 'name', parse: parseTitle(120) },
  goal: { column: 'goal', parse: parseLongText },
  status: { column: 'status', parse: parseOption(SPRINT_STATUSES) },
  startDate: { column: 'start_date', parse: parseNullableDate },
  endDate: { column: 'end_date', parse: parseNullableDate },
};

/**
 * Sprint abbrechen: laufende Agents seiner Aufträge werden beendet (der Worker sieht cancel_requested und bricht den
 * Schritt ab), offene Aufträge verlassen den Sprint wie „aus dem laufenden Sprint genommen“: geplante zurück ins
 * Backlog, laufende schließt der Worker ab (settleItem). Mit dem Vermerk stehen sie unter „Aktionen“ und zur Auswahl für
 * den nächsten Sprint. Erledigte und abgelehnte bleiben beim Sprint; Git-Sicherung und Merge gibt es nicht.
 *
 * Aufträge in Freigabe gehen ebenfalls zurück ins Backlog (statt wie erledigte beim Sprint zu bleiben): Ihre Freigabe
 * mergte in den Sprint-Branch (review_base), der nach dem Abbruch nie in main kommt. Ohne Rücksetzen hingen sie ohne
 * Sprint in Freigabe fest, und „Wieder einplanen“ (/retry nur aus backlog/planned) scheiterte mit 409. Die Arbeit
 * bleibt auf dem Auftrags-Branch; der nächste Lauf setzt dort fort.
 */
export async function cancelSprint(pool: Pool, sprintId: string): Promise<{ stopped: number; released: number }> {
  const stopped = await pool.query(
    `UPDATE agent_run_steps st SET cancel_requested = TRUE
       FROM agent_runs r JOIN development_items d ON d.id = r.development_id
      WHERE r.id = st.run_id AND d.sprint_id = $1 AND st.status = '${AGENT_STEP_STATUS.running}' AND r.status = '${AGENT_RUN_STATUS.running}'`,
    [sprintId],
  );
  const released = await pool.query(
    `UPDATE development_items SET removed_from_sprint = (SELECT name FROM sprints WHERE id = $1),
            removed_from_sprint_at = NOW(), sprint_id = NULL, agent_id = NULL, auto_run = FALSE,
            status = CASE WHEN status IN ('${DEVELOPMENT_STATUS.planned}', '${DEVELOPMENT_STATUS.approval}') THEN '${DEVELOPMENT_STATUS.backlog}' ELSE status END,
            review_branch = NULL, review_base = NULL, review_since = NULL, review_approved_at = NULL, updated_at = NOW()
      WHERE sprint_id = $1 AND status NOT IN ('${DEVELOPMENT_STATUS.done}', '${DEVELOPMENT_STATUS.rejected}')`,
    [sprintId],
  );
  // Eine Pause ist mit dem Abbruch erledigt; wieder geplant startet der Sprint sonst pausiert.
  await pool.query(`UPDATE sprints SET paused_at = NULL, paused_by = NULL WHERE id = $1`, [sprintId]);
  return { stopped: stopped.rowCount ?? 0, released: released.rowCount ?? 0 };
}

const SAME_BRANCH_MESSAGE =
  'Ein anderer Sprint dieses Projekts hat schon einen gleichwertigen Namen (gleicher Git-Branch) – bitte anders benennen.';

/**
 * Zwei Sprints mit gleichem Branch-Namen (z. B. „Sprint 5“ und „sprint-5“, oder Namen, die nach 40 Zeichen gleich
 * werden) teilten sich einen Sprint-Branch: Der neue setzte dann die ungesicherte Arbeit des alten fort. Heute hält
 * sprints.branch den Branch beim Start fest (bei Gleichstand mit ID-Zusatz); die Prüfung vermeidet weiter
 * verwechselbare Namen. Umbenennen ändert den Branch nicht.
 */
async function branchNameTaken(pool: Pool, project: string, name: string, exceptId?: string): Promise<boolean> {
  const branch = sprintBranch(name);
  const others = await pool.query<{ name: string }>(
    'SELECT name FROM sprints WHERE project_slug = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)',
    [project, exceptId ?? null],
  );
  return others.rows.some((sprint) => typeof sprint.name === 'string' && sprintBranch(sprint.name) === branch);
}

function databaseCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export function registerSprintRoutes(app: Router, pool: Pool): void {
  app.get('/projects/:slug/sprints', access({ tenant: 'project' }), async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Ungültiges Projekt.' });
      return;
    }
    const result = await pool.query(
      `SELECT ${SPRINT_COLUMNS} FROM sprints WHERE project_slug = $1
        ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'review' THEN 1 WHEN 'planned' THEN 2 ELSE 3 END, start_date NULLS LAST, created_at`,
      [slug],
    );
    response.json({ sprints: result.rows });
  });

  app.post('/projects/:slug/sprints', access({ role: 'plan', tenant: 'project' }), async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    const fields = parseFields(request.body, SPRINT_FIELDS);
    const values = new Map((fields ?? []).map((field) => [field.column, field.value]));
    // Neue Sprints starten immer als geplant: aktiv und abgeschlossen gibt es nur über die Statuswechsel.
    if (
      !slug ||
      !fields ||
      !values.get('name') ||
      (values.get('status') ?? SPRINT_STATUS.planned) !== SPRINT_STATUS.planned
    ) {
      response
        .status(400)
        .json(slug ? invalidInput(request.body, SPRINT_FIELDS, ['name']) : { message: 'Ungültiges Projekt.' });
      return;
    }
    if (await branchNameTaken(pool, slug, String(values.get('name')))) {
      response.status(409).json({ field: 'name', message: SAME_BRANCH_MESSAGE });
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
        response.status(400).json({ field: 'endDate', message: 'Das Enddatum darf nicht vor dem Startdatum liegen.' });
        return;
      }
      throw error;
    }
  });

  app.patch('/sprints/:id', access({ role: 'plan', tenant: 'sprints' }), async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Nicht gefunden.' });
      return;
    }
    const fields = parseFields(request.body, SPRINT_FIELDS);
    if (!fields) {
      response.status(400).json(invalidInput(request.body, SPRINT_FIELDS));
      return;
    }
    const target = fields.find((field) => field.column === 'status')?.value as string | undefined;
    const rename = fields.find((field) => field.column === 'name')?.value as string | undefined;
    if (rename) {
      const owner = (
        await pool.query<{ slug: string }>('SELECT project_slug AS slug FROM sprints WHERE id = $1', [
          request.params.id,
        ])
      ).rows[0];
      if (owner && (await branchNameTaken(pool, owner.slug, rename, request.params.id))) {
        response.status(409).json({ field: 'name', message: SAME_BRANCH_MESSAGE });
        return;
      }
    }
    try {
      let from: string | undefined;
      if (target) {
        // PR-Modus: Solange der Pull Request offen ist, schließt nur der Worker den Sprint ab (Merge und Tag).
        const current = await pool.query<{
          status: string;
          running: number;
          waiting: number;
          others: number;
          slug: string;
        }>(
          `SELECT status, project_slug AS slug, (SELECT COUNT(*)::int FROM development_items
                            WHERE sprint_id = s.id AND status = '${DEVELOPMENT_STATUS.inProgress}') AS running,
                  (SELECT COUNT(*)::int FROM development_items
                    WHERE sprint_id = s.id AND status = '${DEVELOPMENT_STATUS.approval}') AS waiting,
                  (SELECT COUNT(*)::int FROM sprints o
                    WHERE o.project_slug = s.project_slug AND o.id <> s.id AND o.status = '${SPRINT_STATUS.active}') AS others
             FROM sprints s WHERE id = $1`,
          [request.params.id],
        );
        from = current.rows[0]?.status;
        if (from === SPRINT_STATUS.review) {
          response.status(409).json({
            message: 'Der Sprint ist im Review: Merge und Abschluss folgen nach grüner CI im Pull Request.',
          });
          return;
        }
        // Dieselben Regeln wie die Knöpfe im Sprint-Detail (src/core/sprint-rules.ts).
        const conflict = !from
          ? null
          : !canChangeSprintStatus(from, target)
            ? `Statuswechsel ${from} → ${target} ist für Sprints nicht erlaubt.`
            : target === SPRINT_STATUS.completed
              ? completeSprintConflict(Number(current.rows[0]?.running), Number(current.rows[0]?.waiting))
              : target === SPRINT_STATUS.active && Number(current.rows[0]?.others) > 0
                ? ONE_ACTIVE_MESSAGE
                : null;
        if (conflict) {
          response.status(409).json({ message: conflict });
          return;
        }
        // Git-Zustand: Live schalten braucht einen sauberen Projektordner, Starten einen sauberen Agent-Ordner.
        const slug = current.rows[0]?.slug;
        const guarded =
          target === SPRINT_STATUS.completed
            ? 'go_live'
            : target === SPRINT_STATUS.active && from !== SPRINT_STATUS.active
              ? 'sprint_start'
              : null;
        if (slug && guarded && !(await guardGit(pool, slug, guarded, request.body, response))) return;
      }
      // Status nur ändern, wenn er seit der Prüfung gleich geblieben ist (kein TOCTOU mit Worker oder zweitem Klick).
      const update = buildUpdate(
        'sprints',
        request.params.id,
        fields,
        SPRINT_COLUMNS,
        from ? { column: 'status', values: [from] } : undefined,
      );
      // Nur beim Übergang ≠ abgeschlossen → abgeschlossen: Name oder Ziel eines alten Sprints zu ändern darf Bericht,
      // Merge und Push nicht erneut auslösen. Das UPDATE ist an den gelesenen Status gebunden, der Wechsel also echt.
      const completing = target === SPRINT_STATUS.completed && from !== undefined && from !== SPRINT_STATUS.completed;
      let result;
      if (completing) {
        // Status-UPDATE und Abschluss in einer Transaktion: scheitert der Abschluss (z. B. CHECK end_date >= start_date),
        // bleibt der Sprint aktiv statt „abgeschlossen ohne Bericht“ – und der Worker mergt nichts.
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          result = await client.query(update.sql, update.values);
          if (result.rows[0]) {
            // Sprintende: Bericht, dann Sprint-Branch testen, pushen und nach main mergen (übernimmt der Worker).
            await completeSprintIn(client, request.params.id);
            const fresh = await client.query(`SELECT ${SPRINT_COLUMNS} FROM sprints WHERE id = $1`, [
              request.params.id,
            ]);
            result = fresh.rows[0] ? fresh : result;
          }
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      } else {
        result = await pool.query(update.sql, update.values);
      }
      if (!result.rows[0]) {
        response.status(from ? 409 : 404).json({
          message: from ? 'Der Sprint wurde inzwischen geändert – bitte neu laden.' : 'Sprint nicht gefunden.',
        });
        return;
      }
      if (target === SPRINT_STATUS.cancelled && from !== undefined && from !== SPRINT_STATUS.cancelled) {
        await cancelSprint(pool, request.params.id);
      }
      response.json({ sprint: result.rows[0] });
    } catch (error) {
      const code = databaseCode(error);
      if (code === '23505') {
        response.status(409).json({ message: ONE_ACTIVE_MESSAGE });
        return;
      }
      if (code === '23514') {
        response.status(400).json({ field: 'endDate', message: 'Das Enddatum darf nicht vor dem Startdatum liegen.' });
        return;
      }
      throw error;
    }
  });

  app.post('/sprints/:id/git-sync', access({ role: 'run', tenant: 'sprints' }), async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Nicht gefunden.' });
      return;
    }
    const action = isRecord(request.body) && request.body.action === 'pull' ? 'pull' : 'push';
    const result = await pool.query(
      `UPDATE sprints SET git_sync = 'pending', git_action = $2, git_message = NULL
        WHERE id = $1 AND (git_sync IS NULL OR git_sync IN ('done', 'failed', 'awaiting_merge'))
        RETURNING ${SPRINT_COLUMNS}`,
      [request.params.id, action],
    );
    if (!result.rows[0]) {
      response.status(409).json({ message: 'Die Git-Sicherung dieses Sprints läuft bereits.' });
      return;
    }
    response.json({ sprint: result.rows[0] });
  });

  // Sprint pausieren: laufende Agents beenden ihren Schritt, danach startet kein weiterer Schritt und kein Auftrag.
  // Angefangene Aufträge bleiben „Geplant“ und machen nach dem Fortsetzen beim nächsten Agent weiter.
  app.post('/sprints/:id/pause', access({ role: 'run', tenant: 'sprints' }), async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Nicht gefunden.' });
      return;
    }
    const principal = response.locals.principal as Principal | undefined;
    const result = await pool.query(
      `UPDATE sprints SET paused_at = COALESCE(paused_at, NOW()), paused_by = COALESCE(paused_by, $2)
        WHERE id = $1 AND status = '${SPRINT_STATUS.active}' RETURNING ${SPRINT_COLUMNS}`,
      [request.params.id, principal?.displayName ?? null],
    );
    if (!result.rows[0]) {
      response.status(409).json({ message: 'Nur ein aktiver Sprint lässt sich pausieren.' });
      return;
    }
    response.json({ sprint: result.rows[0] });
  });

  app.post('/sprints/:id/resume', access({ role: 'run', tenant: 'sprints' }), async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Nicht gefunden.' });
      return;
    }
    const result = await pool.query(
      `UPDATE sprints SET paused_at = NULL, paused_by = NULL WHERE id = $1 RETURNING ${SPRINT_COLUMNS}`,
      [request.params.id],
    );
    if (!result.rows[0]) {
      response.status(404).json({ message: 'Sprint nicht gefunden.' });
      return;
    }
    response.json({ sprint: result.rows[0] });
  });

  // Kanban: Reihenfolge der Aufträge im Sprint festlegen (oberste zuerst).
  app.post('/sprints/:id/order', access({ role: 'plan', tenant: 'sprints' }), async (request, response, next) => {
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

  app.delete('/sprints/:id', access({ role: 'plan', tenant: 'sprints' }), async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Nicht gefunden.' });
      return;
    }
    // Nur geplante, abgeschlossene oder abgebrochene Sprints ohne laufende Git-Sicherung und ohne Aufträge, die laufen
    // oder auf Freigabe warten: sonst verlieren diese ihren Sprint (die Freigabe mergte danach ohne Sprint) bzw. ein
    // offener PR bleibt ohne Sprint zurück. Gleiche Regel wie canDeleteSprint (src/core/sprint-rules.ts).
    const deletable = `status IN (${sqlList(DELETABLE_SPRINT_STATUSES)})
          AND (git_sync IS NULL OR git_sync IN (${sqlList(IDLE_SPRINT_GIT_SYNC)}))
          AND NOT EXISTS (SELECT 1 FROM development_items WHERE sprint_id = s.id AND status IN (${sqlList(SPRINT_HOLDING_DEVELOPMENT_STATUSES)}))`;
    // Geplante Aufträge eines gelöschten Sprints sind nicht mehr geplant: zurück ins Backlog, sonst stünden sie als
    // „Geplant“ ohne Sprint in der Liste (den Sprint-Verweis löscht der Fremdschlüssel). Einzeln gestartete behalten
    // ihren Status (agent_id), sie laufen ohne Sprint.
    await pool.query(
      `UPDATE development_items SET status = '${DEVELOPMENT_STATUS.backlog}', updated_at = NOW()
        WHERE sprint_id = $1 AND status = '${DEVELOPMENT_STATUS.planned}' AND agent_id IS NULL
          AND EXISTS (SELECT 1 FROM sprints s WHERE s.id = $1 AND ${deletable})`,
      [request.params.id],
    );
    const result = await pool.query(`DELETE FROM sprints s WHERE id = $1 AND ${deletable} RETURNING id`, [
      request.params.id,
    ]);
    if (!result.rows[0]) {
      const exists = (await pool.query('SELECT 1 FROM sprints WHERE id = $1', [request.params.id])).rows[0];
      if (exists) {
        response.status(409).json({
          message:
            'Nur geplante, abgeschlossene oder abgebrochene Sprints ohne Git-Sicherung und ohne Aufträge, die laufen oder auf Freigabe warten, lassen sich löschen.',
        });
        return;
      }
      response.status(404).json({ message: 'Sprint nicht gefunden.' });
      return;
    }
    response.status(204).end();
  });
}
