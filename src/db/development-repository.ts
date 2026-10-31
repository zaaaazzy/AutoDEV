// Datenzugriff für Aufträge (development_items): alle SQL-Anweisungen der Auftrags-Routen an einer Stelle.
import type { Pool } from 'pg';
import {
  ASSIGNABLE_SPRINT_STATUSES,
  REPLANNABLE_DEVELOPMENT_STATUSES,
  RETRYABLE_DEVELOPMENT_STATUSES,
  SPRINT_POOL_DEVELOPMENT_STATUSES,
  SPRINT_REMOVABLE_DEVELOPMENT_STATUSES,
} from '../core/development-transitions.js';
import { OVERRUN_TODO_PREFIX } from '../core/estimate-overrun.js';
import { DEVELOPMENT_STATUS, IDEATION_STATUS } from '../core/status.js';
import { buildUpdate } from '../core/validation.js';
import { isUniqueViolation, withTransaction } from './transaction.js';

/**
 * Spalten eines Auftrags. fixStatus: Die innere Tabelle ist auf bug_id/status/created_at beschränkt, damit
 * failure_bug_id die Spalte der äusseren Zeile meint – mit vollem Alias löste Postgres sie auf die innere auf.
 * Funktioniert so mit und ohne Alias der äusseren Abfrage (z. B. `UPDATE development_items d … RETURNING`).
 */
export const DEV_COLUMNS = `id, ideation_id AS "ideationId", test_run_id AS "testRunId", sprint_id AS "sprintId",
  title, description, status, priority, created_at AS "createdAt",
  effort_hours AS "effortHours", token_estimate AS "tokenEstimate", estimate_source AS "estimateSource", benefit, cost,
  kind, category, bug_id AS "bugId", completed_at AS "completedAt", agent_id AS "agentId", risks, project_context AS "projectContext",
  retry_count AS "retryCount", analysis_status AS "analysisStatus", analysis,
  failure, failure_bug_id AS "failureBugId", action_todo AS "actionTodo",
  follow_up_of AS "followUpOf",
  (SELECT f.status FROM (SELECT bug_id, status, created_at FROM development_items) f
    WHERE f.bug_id = failure_bug_id ORDER BY f.created_at DESC LIMIT 1) AS "fixStatus",
  removed_from_sprint AS "removedFromSprint", removed_from_sprint_at AS "removedFromSprintAt",
  sprint_rank AS "sprintRank", review_branch AS "reviewBranch", review_since AS "reviewSince",
  review_approved_at AS "reviewApprovedAt", visual_approved_at AS "visualApprovedAt",
  visual_approved_by AS "visualApprovedBy", changed_files AS "changedFiles", counter_check AS "counterCheck"`;

/** Zeile mit DEV_COLUMNS; die Routen geben sie unverändert als JSON weiter. */
export type DevelopmentRow = Record<string, unknown>;

/** Feste Statusliste aus development-transitions für `IN (…)` (eigene Konstanten, keine Benutzereingabe). */
const sqlList = (statuses: readonly string[]): string => statuses.map((status) => `'${status}'`).join(', ');

const ASSIGNABLE_SPRINTS_SQL = sqlList(ASSIGNABLE_SPRINT_STATUSES);

/** Abgebrochen: aus einem laufenden Sprint genommen oder blockiert (Alias d). */
const ABORTED_SQL = `(d.removed_from_sprint_at IS NOT NULL OR d.status = '${DEVELOPMENT_STATUS.blocked}')`;

/**
 * Ziel-Sprint von /retry und review-reject (Alias d): der gewählte (`chosen`, SQL-Ausdruck oder NULL), sonst der
 * bisherige, wenn er noch geplant oder aktiv ist, sonst der aktive Sprint des Projekts bzw. keiner (main). Im Review,
 * abgeschlossen oder abgebrochen nimmt ein Sprint keine Arbeit mehr an – der Auftrag liefe auf dessen altem Branch.
 */
export function retrySprintSql(chosen = 'NULL::uuid'): string {
  return `COALESCE(${chosen},
                (SELECT s.id FROM sprints s WHERE s.id = d.sprint_id AND s.status IN (${ASSIGNABLE_SPRINTS_SQL})),
                (SELECT s.id FROM sprints s WHERE s.project_slug = d.project_slug AND s.status = 'active'
                  ORDER BY s.created_at LIMIT 1))`;
}

/** auto_run folgt dem Ziel-Sprint: ohne Sprint oder im aktiven sofort, ein geplanter wartet auf seinen Start. */
export function retryAutoRunSql(chosen = 'NULL::uuid'): string {
  return `COALESCE((SELECT t.status = 'active' FROM sprints t WHERE t.id = ${retrySprintSql(chosen)}), TRUE)`;
}

/**
 * Idee als Auftrag übernehmen. Auftrag und Status der Idee zusammen oder gar nicht. Ein zweiter Klick, der parallel
 * am NOT EXISTS vorbeikommt, scheitert am Unique-Index auf development_items(ideation_id) (23505). null = Idee fehlt
 * oder ist schon übernommen.
 */
export async function promoteIdea(pool: Pool, ideaId: string): Promise<DevelopmentRow | null> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<DevelopmentRow>(
      `INSERT INTO development_items (project_slug, ideation_id, title, description, status, priority,
                                      effort_hours, token_estimate, benefit, cost, estimate_source)
       SELECT i.project_slug, i.id, i.title, i.description, '${DEVELOPMENT_STATUS.backlog}', i.priority,
              i.effort_hours, i.token_estimate, i.benefit, i.cost, i.estimate_source
         FROM ideation_items i
        WHERE i.id = $1
          AND NOT EXISTS (SELECT 1 FROM development_items d WHERE d.ideation_id = i.id)
       RETURNING ${DEV_COLUMNS}`,
      [ideaId],
    );
    if (!result.rows[0]) return null;
    await client.query(
      `UPDATE ideation_items SET status = '${IDEATION_STATUS.accepted}', updated_at = NOW() WHERE id = $1`,
      [ideaId],
    );
    return result.rows[0];
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) return null;
    throw error;
  });
}

export interface NewOrder {
  ideationId: string | null;
  testRunId: string | null;
  title: string;
  description: string;
  status: string | null;
  priority: string | null;
  category: string | null;
}

/**
 * Neuer Auftrag. 'duplicate': zur Idee gibt es schon einen Auftrag (Unique-Index auf ideation_id); 'foreign': Idee
 * oder Testlauf gehören nicht zum Projekt.
 */
export async function insertOrder(
  pool: Pool,
  projectSlug: string,
  order: NewOrder,
): Promise<DevelopmentRow | 'duplicate' | 'foreign'> {
  const result = await pool
    .query<DevelopmentRow>(
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
        projectSlug,
        order.ideationId,
        order.testRunId,
        order.title,
        order.description,
        order.status,
        order.priority,
        order.category,
      ],
    )
    .catch((error: unknown) => {
      if (isUniqueViolation(error)) return null;
      throw error;
    });
  if (!result) return 'duplicate';
  return result.rows[0] ?? 'foreign';
}

export async function findOrderSummary(
  pool: Pool,
  id: string,
): Promise<{ projectSlug: string; status: string; category: string | null } | undefined> {
  const result = await pool.query<{ projectSlug: string; status: string; category: string | null }>(
    `SELECT project_slug AS "projectSlug", status, category FROM development_items WHERE id = $1`,
    [id],
  );
  return result.rows[0];
}

export async function findOrderState(
  pool: Pool,
  id: string,
): Promise<{ status: string; sprintId: string | null } | undefined> {
  const result = await pool.query<{ status: string; sprintId: string | null }>(
    `SELECT status, sprint_id AS "sprintId" FROM development_items WHERE id = $1`,
    [id],
  );
  return result.rows[0];
}

export async function orderExists(pool: Pool, id: string): Promise<boolean> {
  return Boolean((await pool.query(`SELECT 1 FROM development_items WHERE id = $1`, [id])).rows[0]);
}

/** Ergebnis der Gegenprobe am Auftrag; jeder neue Lauf überschreibt das vorige (auch die Markierung). */
export async function saveCounterCheck(pool: Pick<Pool, 'query'>, id: string, check: object): Promise<void> {
  await pool.query('UPDATE development_items SET counter_check = $2::jsonb WHERE id = $1', [id, JSON.stringify(check)]);
}

/** Status des Sprints, wenn er zum Projekt gehört. */
export async function findProjectSprintStatus(
  pool: Pool,
  sprintId: string,
  projectSlug: string,
): Promise<string | undefined> {
  const result = await pool.query<{ status: string }>(
    'SELECT status FROM sprints WHERE id = $1 AND project_slug = $2',
    [sprintId, projectSlug],
  );
  return result.rows[0]?.status;
}

/** Status des Sprints, wenn er zum Projekt des Auftrags gehört. */
export async function findOrderSprintStatus(
  pool: Pool,
  sprintId: string,
  orderId: string,
): Promise<string | undefined> {
  const result = await pool.query<{ sprintStatus: string }>(
    `SELECT s.status AS "sprintStatus" FROM sprints s JOIN development_items e ON e.project_slug = s.project_slug
      WHERE s.id = $1 AND e.id = $2`,
    [sprintId, orderId],
  );
  return result.rows[0]?.sprintStatus;
}

export async function agentInOrderProject(pool: Pool, agentId: string, orderId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM agents a JOIN development_items d ON d.project_slug = a.project_slug
      WHERE a.id = $1 AND d.id = $2`,
    [agentId, orderId],
  );
  return Boolean(result.rows[0]);
}

export async function insertFollowUp(
  pool: Pool,
  followUp: {
    projectSlug: string;
    title: string;
    description: string;
    priority: string | null;
    category: string | null;
    sprintId: string | null;
    followUpOf: string;
  },
): Promise<DevelopmentRow | undefined> {
  const result = await pool.query<DevelopmentRow>(
    `INSERT INTO development_items (project_slug, title, description, status, priority, category, sprint_id, follow_up_of)
     VALUES ($1, $2, $3, $4, COALESCE($5, 'medium'), $6, $7, $8)
     RETURNING ${DEV_COLUMNS}`,
    [
      followUp.projectSlug,
      followUp.title,
      followUp.description,
      followUp.sprintId ? DEVELOPMENT_STATUS.planned : DEVELOPMENT_STATUS.backlog,
      followUp.priority,
      followUp.category,
      followUp.sprintId,
      followUp.followUpOf,
    ],
  );
  return result.rows[0];
}

/**
 * Blockierten, abgelehnten oder aus dem Sprint genommenen Auftrag erneut einplanen, Status und Sprint in einem
 * UPDATE. Der Bug-Status folgt per Trigger in derselben Anweisung (abgelehnter Bug wird wieder offen).
 */
export async function retryOrder(
  pool: Pool,
  id: string,
  comment: string | null,
  sprintId: string | null,
): Promise<DevelopmentRow | undefined> {
  // Freigabe nach „Schätzung überschritten“ ist kein Fehlversuch: kein Wiederholungszähler (Modell-Routing, Planung).
  // budget_since = NOW(): Ab hier zählt der Verbrauch neu gegen die (ggf. angepasste) Schätzung.
  const countsAsRetry =
    `d.status = '${DEVELOPMENT_STATUS.blocked}'` +
    ` AND NOT starts_with(COALESCE(d.action_todo, ''), '${OVERRUN_TODO_PREFIX}')`;
  const result = await pool.query<DevelopmentRow>(
    `UPDATE development_items d SET status = '${DEVELOPMENT_STATUS.planned}', auto_run = ${retryAutoRunSql('$3::uuid')},
            failure = NULL, action_todo = NULL, conflict_retries = 0,
            description = CASE WHEN $2::text IS NULL THEN d.description
                               ELSE COALESCE(d.description, '') || E'\n\n## Hinweis zum erneuten Versuch (' || to_char(NOW(), 'DD.MM.YYYY HH24:MI') || E')\n' || $2::text END,
            retry_count = retry_count + CASE WHEN ${countsAsRetry} THEN 1 ELSE 0 END,
            analysis_status = CASE WHEN analysis_status IN ('requested', 'running') THEN analysis_status ELSE NULL END,
            sprint_id = ${retrySprintSql('$3::uuid')},
            removed_from_sprint = NULL, removed_from_sprint_at = NULL, budget_since = NOW(), updated_at = NOW()
      WHERE d.id = $1 AND d.kind <> 'express' AND (d.status IN (${sqlList(RETRYABLE_DEVELOPMENT_STATUSES)})
            OR (d.removed_from_sprint_at IS NOT NULL AND d.status IN (${sqlList(REPLANNABLE_DEVELOPMENT_STATUSES)})))
        AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM sprints s WHERE s.id = $3::uuid
                                           AND s.project_slug = d.project_slug AND s.status IN (${ASSIGNABLE_SPRINTS_SQL})))
      RETURNING ${DEV_COLUMNS}`,
    [id, comment, sprintId],
  );
  return result.rows[0];
}

/** Nimmt der Sprint noch Aufträge des Projekts dieses Auftrags an (geplant oder aktiv)? */
export async function sprintAcceptsOrder(pool: Pool, orderId: string, sprintId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM sprints s JOIN development_items d ON d.project_slug = s.project_slug
      WHERE d.id = $1 AND s.id = $2 AND s.status IN (${ASSIGNABLE_SPRINTS_SQL})`,
    [orderId, sprintId],
  );
  return Boolean(result.rowCount);
}

/**
 * Offenen oder abgebrochenen Auftrag ohne Sprint in einen geplanten oder aktiven Sprint übernehmen. Abgebrochene
 * werden wie bei retryOrder zurückgesetzt und nur mit `mayRetry` übernommen. auto_run nur, wenn der Sprint läuft.
 * Ohne Join auf sprints: DEV_COLUMNS (RETURNING) nennt id und status ohne Tabellen-Präfix.
 */
export async function takeIntoSprint(
  pool: Pool,
  id: string,
  sprintId: string,
  mayRetry: boolean,
): Promise<DevelopmentRow | undefined> {
  const aborted = ABORTED_SQL;
  const result = await pool.query<DevelopmentRow>(
    `UPDATE development_items d SET status = '${DEVELOPMENT_STATUS.planned}', sprint_id = $2,
            auto_run = COALESCE((SELECT s.status = 'active' FROM sprints s WHERE s.id = $2), FALSE),
            agent_id = CASE WHEN ${aborted} THEN NULL ELSE d.agent_id END,
            failure = CASE WHEN ${aborted} THEN NULL ELSE d.failure END,
            action_todo = CASE WHEN ${aborted} THEN NULL ELSE d.action_todo END,
            conflict_retries = CASE WHEN ${aborted} THEN 0 ELSE d.conflict_retries END,
            retry_count = d.retry_count + CASE WHEN d.status = '${DEVELOPMENT_STATUS.blocked}' THEN 1 ELSE 0 END,
            analysis_status = CASE WHEN NOT ${aborted} OR d.analysis_status IN ('requested', 'running')
                                   THEN d.analysis_status ELSE NULL END,
            budget_since = CASE WHEN ${aborted} THEN NOW() ELSE d.budget_since END,
            removed_from_sprint = NULL, removed_from_sprint_at = NULL, updated_at = NOW()
      WHERE d.id = $1 AND d.sprint_id IS NULL AND d.kind <> 'express'
        AND d.status IN (${sqlList(SPRINT_POOL_DEVELOPMENT_STATUSES)})
        AND ($3::boolean OR NOT ${aborted})
        AND EXISTS (SELECT 1 FROM sprints s WHERE s.id = $2 AND s.project_slug = d.project_slug
                       AND s.status IN ('planned', 'active'))
      RETURNING ${DEV_COLUMNS}`,
    [id, sprintId, mayRetry],
  );
  return result.rows[0];
}

export async function isAbortedOrder(pool: Pool, id: string): Promise<boolean> {
  const result = await pool.query(`SELECT 1 FROM development_items d WHERE d.id = $1 AND ${ABORTED_SQL}`, [id]);
  return Boolean(result.rowCount);
}

/**
 * Aus dem Sprint nehmen. Aus einem noch geplanten Sprint ist das reine Planung: kein Vermerk, also auch keine Karte
 * unter „Aktionen“. Erst aus einem laufenden Sprint gilt ein Auftrag als abgebrochen und wartet auf eine
 * Entscheidung. Auftrags- und Sprint-Status in derselben Anweisung: Im Review steckt der Sprint-Branch schon im PR.
 */
export async function removeFromSprint(pool: Pool, id: string): Promise<DevelopmentRow | undefined> {
  const result = await pool.query<DevelopmentRow>(
    `UPDATE development_items SET
            removed_from_sprint = (SELECT name FROM sprints WHERE id = development_items.sprint_id AND status <> 'planned'),
            removed_from_sprint_at = CASE WHEN (SELECT status FROM sprints WHERE id = development_items.sprint_id) = 'planned'
                                          THEN NULL ELSE NOW() END,
            sprint_id = NULL, agent_id = NULL, auto_run = FALSE,
            status = CASE WHEN status = '${DEVELOPMENT_STATUS.planned}' THEN '${DEVELOPMENT_STATUS.backlog}' ELSE status END,
            updated_at = NOW()
      WHERE id = $1 AND status IN (${sqlList(SPRINT_REMOVABLE_DEVELOPMENT_STATUSES)})
        AND EXISTS (SELECT 1 FROM sprints s WHERE s.id = development_items.sprint_id
                       AND s.status IN (${ASSIGNABLE_SPRINTS_SQL}))
      RETURNING ${DEV_COLUMNS}`,
    [id],
  );
  return result.rows[0];
}

/**
 * Auftrag löschen, solange er nicht läuft, und die Idee wieder öffnen – in einer Transaktion, sonst bliebe die Idee
 * bei einem Fehler auf „angenommen“. false = Auftrag läuft gerade.
 */
export async function deleteOrder(pool: Pool, id: string): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<{ id: string; ideationId: string | null }>(
      `DELETE FROM development_items WHERE id = $1 AND status <> '${DEVELOPMENT_STATUS.inProgress}'
       RETURNING id, ideation_id AS "ideationId"`,
      [id],
    );
    const row = result.rows[0];
    // Ohne Auftrag ist die Idee wieder offen (sonst hinge sie dauerhaft auf „Auftrag wird bearbeitet“).
    if (row?.ideationId) {
      await client.query(
        `UPDATE ideation_items SET status = '${IDEATION_STATUS.idea}', updated_at = NOW()
          WHERE id = $1 AND status = '${IDEATION_STATUS.accepted}'
            AND NOT EXISTS (SELECT 1 FROM development_items WHERE ideation_id = $1)`,
        [row.ideationId],
      );
    }
    return Boolean(row);
  });
}

/** Vom Tester gemeldete Punkte „von dir zu prüfen“ als geprüft bestätigen; gibt die Anzahl zurück. */
export async function confirmManualAcceptance(pool: Pool, id: string): Promise<number> {
  const result = await pool.query(
    `UPDATE acceptance_checks SET status = 'met', note = TRIM(note || ' (von dir bestätigt)'), checked_at = NOW()
      WHERE development_id = $1 AND status = 'manual'`,
    [id],
  );
  return result.rowCount ?? 0;
}

/** Problemanalyse für einen blockierten Auftrag anfordern, sofern keine läuft. */
export async function requestAnalysis(pool: Pool, id: string): Promise<DevelopmentRow | undefined> {
  const result = await pool.query<DevelopmentRow>(
    `UPDATE development_items SET analysis_status = 'requested', updated_at = NOW()
      WHERE id = $1 AND status = '${DEVELOPMENT_STATUS.blocked}' AND kind <> 'express'
        AND COALESCE(analysis_status, 'done') NOT IN ('requested', 'running') RETURNING ${DEV_COLUMNS}`,
    [id],
  );
  return result.rows[0];
}

/**
 * Felder eines Auftrags ändern. Mit `expectedStatus` nur, wenn der Status seit der Prüfung gleich geblieben ist (kein
 * Wettlauf mit dem Worker).
 */
export async function updateOrder(
  pool: Pool,
  id: string,
  fields: { column: string; value: unknown }[],
  expectedStatus: string | undefined,
  extras: string[],
): Promise<DevelopmentRow | undefined> {
  const update = buildUpdate(
    'development_items',
    id,
    fields,
    `${DEV_COLUMNS}, project_slug AS "projectSlug"`,
    expectedStatus ? { column: 'status', values: [expectedStatus] } : undefined,
    extras,
  );
  const result = await pool.query<DevelopmentRow>(update.sql, update.values);
  return result.rows[0];
}
