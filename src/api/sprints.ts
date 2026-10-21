import type { Router } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import type { Principal } from './roles.js';
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
  git_commit AS "gitCommit", git_branch AS "gitBranch", git_synced_at AS "gitSyncedAt", pr_url AS "prUrl", ci_status AS "ciStatus",
  review_ready_at AS "reviewReadyAt", paused_at AS "pausedAt", paused_by AS "pausedBy"`;
// Erlaubte Statuswechsel per PATCH. Review → abgeschlossen übernimmt der Worker (Merge nach grüner CI).
// Abgeschlossen → aktiv ist „Wieder öffnen“ in der Oberfläche.
const SPRINT_TRANSITIONS: Record<string, readonly string[]> = {
  planned: ['active'],
  active: ['planned', 'completed'],
  completed: ['active'],
};
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

export function registerSprintRoutes(app: Router, pool: Pool): void {
  app.get('/projects/:slug/sprints', access({ tenant: 'project' }), async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Invalid project slug.' });
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
    if (!slug || !fields || !values.get('name') || (values.get('status') ?? 'planned') !== 'planned') {
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

  app.patch('/sprints/:id', access({ role: 'plan', tenant: 'sprints' }), async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    const fields = parseFields(request.body, SPRINT_FIELDS);
    if (!fields) {
      response.status(400).json({ message: 'Invalid sprint update.' });
      return;
    }
    const target = fields.find((field) => field.column === 'status')?.value as string | undefined;
    try {
      let from: string | undefined;
      if (target) {
        // PR-Modus: Solange der Pull Request offen ist, schließt nur der Worker den Sprint ab (Merge und Tag).
        const current = await pool.query<{ status: string; running: number }>(
          `SELECT status, (SELECT COUNT(*)::int FROM development_items
                            WHERE sprint_id = s.id AND status = 'in_progress') AS running
             FROM sprints s WHERE id = $1`,
          [request.params.id],
        );
        from = current.rows[0]?.status;
        if (from === 'review') {
          response.status(409).json({
            message: 'Der Sprint ist im Review: Merge und Abschluss folgen nach grüner CI im Pull Request.',
          });
          return;
        }
        const conflict = !from
          ? null
          : !SPRINT_TRANSITIONS[from]?.includes(target)
            ? `Statuswechsel ${from} → ${target} ist für Sprints nicht erlaubt.`
            : target === 'completed' && Number(current.rows[0]?.running) > 0
              ? 'Im Sprint laufen noch Aufträge – erst abwarten oder stoppen, dann abschließen.'
              : null;
        if (conflict) {
          response.status(409).json({ message: conflict });
          return;
        }
      }
      // Status nur ändern, wenn er seit der Prüfung gleich geblieben ist (kein TOCTOU mit Worker oder zweitem Klick).
      const update = buildUpdate(
        'sprints',
        request.params.id,
        fields,
        SPRINT_COLUMNS,
        from ? { column: 'status', values: [from] } : undefined,
      );
      const result = await pool.query(update.sql, update.values);
      if (!result.rows[0]) {
        response
          .status(from ? 409 : 404)
          .json({ message: from ? 'Der Sprint wurde inzwischen geändert – bitte neu laden.' : 'Sprint not found.' });
        return;
      }
      // Nur beim Übergang ≠ abgeschlossen → abgeschlossen: Name oder Ziel eines alten Sprints zu ändern darf Bericht,
      // Merge und Push nicht erneut auslösen. Das UPDATE oben war an den gelesenen Status gebunden, der Wechsel also echt.
      if (target === 'completed' && from !== undefined && from !== 'completed') {
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

  app.post('/sprints/:id/git-sync', access({ role: 'run', tenant: 'sprints' }), async (request, response) => {
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

  // Sprint pausieren: laufende Agents beenden ihren Schritt, danach startet kein weiterer Schritt und kein Auftrag.
  // Angefangene Aufträge bleiben „Geplant“ und machen nach dem Fortsetzen beim nächsten Agent weiter.
  app.post('/sprints/:id/pause', access({ role: 'run', tenant: 'sprints' }), async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    const principal = response.locals.principal as Principal | undefined;
    const result = await pool.query(
      `UPDATE sprints SET paused_at = COALESCE(paused_at, NOW()), paused_by = COALESCE(paused_by, $2)
        WHERE id = $1 AND status = 'active' RETURNING ${SPRINT_COLUMNS}`,
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
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    const result = await pool.query(
      `UPDATE sprints SET paused_at = NULL, paused_by = NULL WHERE id = $1 RETURNING ${SPRINT_COLUMNS}`,
      [request.params.id],
    );
    if (!result.rows[0]) {
      response.status(404).json({ message: 'Sprint not found.' });
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
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    // Nur geplante oder abgeschlossene Sprints ohne laufende Aufträge und ohne laufende Git-Sicherung:
    // sonst verlieren laufende Aufträge ihren Sprint bzw. ein offener PR bleibt ohne Sprint zurück.
    const result = await pool.query(
      `DELETE FROM sprints s WHERE id = $1 AND status IN ('planned', 'completed')
          AND (git_sync IS NULL OR git_sync IN ('done', 'failed'))
          AND NOT EXISTS (SELECT 1 FROM development_items WHERE sprint_id = s.id AND status = 'in_progress')
        RETURNING id`,
      [request.params.id],
    );
    if (!result.rows[0]) {
      const exists = (await pool.query('SELECT 1 FROM sprints WHERE id = $1', [request.params.id])).rows[0];
      if (exists) {
        response.status(409).json({
          message:
            'Nur geplante oder abgeschlossene Sprints ohne laufende Aufträge und Git-Sicherung lassen sich löschen.',
        });
        return;
      }
      response.status(404).json({ message: 'Sprint not found.' });
      return;
    }
    response.status(204).end();
  });
}
