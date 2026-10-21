import { logged } from '../core/log.js';
import type { Router } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import { DEFAULT_DEFINITION_OF_DONE, DEFAULT_DEFINITION_OF_READY } from '../runner/acceptance.js';
import { isRecord, isUuid, parseProjectSlug } from '../core/validation.js';
import { refreshAcceptanceTodo } from '../runner/action-todo.js';

const OPEN_STATUSES = ['open', 'unmet', 'manual'];
/** Akzeptanzkriterien, DoD-Punkte und Befunde der visuellen Prüfung. */
const CHECK_KINDS = ['criterion', 'done', 'visual'];

/** Abnahme je Auftrag (Akzeptanzkriterien und DoD-Punkte mit Status) sowie die Standard-Definitionen. */
export function registerAcceptanceRoutes(app: Router, pool: Pool): void {
  app.get('/projects/:slug/acceptance', access({ tenant: 'project' }), async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
      const checks = (
        await pool.query(
          `SELECT a.development_id AS "developmentId", a.kind, a.position, a.text, a.status, a.note, a.checked_at AS "checkedAt"
             FROM acceptance_checks a JOIN development_items d ON d.id = a.development_id
            WHERE d.project_slug = $1 ORDER BY a.development_id, a.kind, a.position`,
          [slug],
        )
      ).rows;
      response.json({
        checks,
        defaults: { definitionOfReady: DEFAULT_DEFINITION_OF_READY, definitionOfDone: DEFAULT_DEFINITION_OF_DONE },
      });
    } catch (error) {
      next(error);
    }
  });

  // Einzelnen Abnahmepunkt abhaken (erledigt) oder wieder öffnen.
  app.post(
    '/development/:id/acceptance/check',
    access({ role: 'plan', tenant: 'development' }),
    async (request, response, next) => {
      try {
        const body = request.body as unknown;
        if (
          !isUuid(request.params.id) ||
          !isRecord(body) ||
          !CHECK_KINDS.includes(String(body.kind)) ||
          !Number.isInteger(body.position) ||
          typeof body.checked !== 'boolean'
        ) {
          return void response.status(400).json({ message: 'Abnahmepunkt ungültig.' });
        }
        const result = await pool.query(
          body.checked
            ? `UPDATE acceptance_checks SET status = 'met', checked_at = NOW(),
                    note = CASE WHEN note LIKE '%(von dir abgehakt)%' THEN note ELSE TRIM(note || ' (von dir abgehakt)') END
              WHERE development_id = $1 AND kind = $2 AND position = $3 AND status <> 'checking'`
            : `UPDATE acceptance_checks SET status = 'open', checked_at = NOW(),
                    note = TRIM(REPLACE(note, '(von dir abgehakt)', ''))
              WHERE development_id = $1 AND kind = $2 AND position = $3 AND status <> 'checking'`,
          [request.params.id, body.kind, body.position],
        );
        if (!result.rowCount) return void response.status(404).json({ message: 'Abnahmepunkt nicht gefunden.' });
        await refreshAcceptanceTodo(pool, request.params.id).catch(logged('acceptance'));
        response.json({ ok: true });
      } catch (error) {
        next(error);
      }
    },
  );

  // Offene Punkte (oder einen einzelnen) vom Tester-Agent automatisch prüfen lassen; der Worker übernimmt.
  app.post(
    '/development/:id/acceptance/verify',
    access({ role: 'plan', tenant: 'development' }),
    async (request, response, next) => {
      try {
        const body = (isRecord(request.body) ? request.body : {}) as Record<string, unknown>;
        if (!isUuid(request.params.id)) return void response.status(404).json({ message: 'Auftrag nicht gefunden.' });
        const single = CHECK_KINDS.includes(String(body.kind)) && Number.isInteger(body.position);
        const result = await pool.query(
          `UPDATE acceptance_checks SET status = 'verifying', checked_at = NOW()
          WHERE development_id = $1 AND status = ANY($2)
            AND ($3::text IS NULL OR (kind = $3 AND position = $4::int))`,
          [request.params.id, OPEN_STATUSES, single ? body.kind : null, single ? body.position : null],
        );
        response.json({ queued: result.rowCount ?? 0 });
      } catch (error) {
        next(error);
      }
    },
  );
}
