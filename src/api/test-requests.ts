import type { Router, Response } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import { isAllowedCommand } from '../agent/command-checks.js';
import { isRecord, isUuid, parseProjectSlug } from '../core/validation.js';
import type { Principal } from './roles.js';

/**
 * Kompletter Test auf Knopfdruck: Die Oberfläche fordert ihn an, der Worker führt ihn im Projektordner aus
 * (alle Teststufen inkl. Playwright), legt den Lauf unter „Testläufe“ ab und aus den Befunden Bugs an.
 */
export const COLUMNS = `id, scope, status, requested_by AS "requestedBy", run_id AS "runId", bug_count AS "bugCount",
  error, comment, created_at AS "createdAt", started_at AS "startedAt", finished_at AS "finishedAt"`;

export function parseScope(body: unknown): 'full' | 'ui' | null {
  const scope = isRecord(body) ? (body.scope ?? 'full') : 'full';
  return scope === 'full' || scope === 'ui' ? scope : null;
}

/**
 * Start eines Testnachweises: Der Body darf nur einen Kommentar tragen. Ein Befehl (oder anderes Feld) im Request wird
 * abgelehnt – der Befehl stammt ausschließlich aus der gespeicherten Zeile in test_evidence.
 */
export function evidenceBodyProblem(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  if (!isRecord(body)) return 'Ungültige Anfrage.';
  const extra = Object.keys(body).filter((key) => key !== 'comment');
  return extra.length ? `Nur die Nachweis-ID zählt – Felder wie „${extra[0]}“ sind nicht erlaubt.` : null;
}

/** Offene Testnachweise eines Projekts (nicht abgehakt), mit Prüfung des Befehls und laufendem Test. */
export const EVIDENCE_COLUMNS = `e.id, e.development_id AS "developmentId", e.position, e.datei, e.befehl, e.grund, e.status,
  e.agent_name AS "agentName", e.run_id AS "runId", e.checked_at AS "checkedAt", e.created_at AS "createdAt"`;

export function registerTestRequestRoutes(app: Router, pool: Pool): void {
  const me = (response: Response) => response.locals.principal as Principal | undefined;

  app.get('/projects/:slug/test-evidence', access({ tenant: 'project' }), async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
      const rows = (
        await pool.query<{ befehl: string } & Record<string, unknown>>(
          `SELECT ${EVIDENCE_COLUMNS},
                  EXISTS (SELECT 1 FROM test_requests r WHERE r.evidence_id = e.id AND r.status IN ('requested', 'running'))
                    AS running
             FROM test_evidence e JOIN development_items d ON d.id = e.development_id
            WHERE d.project_slug = $1 AND e.status <> 'passed'
            ORDER BY e.development_id, e.position`,
          [slug],
        )
      ).rows;
      const open = (
        await pool.query(`SELECT 1 FROM test_requests WHERE project_slug = $1 AND status IN ('requested', 'running')`, [
          slug,
        ])
      ).rows;
      response.json({
        evidence: rows.map((row) => ({ ...row, allowed: isAllowedCommand(row.befehl) })),
        testRunning: open.length > 0,
      });
    } catch (error) {
      next(error);
    }
  });

  // Testnachweis als Projekttestlauf starten: übergeben wird nur die ID, der Worker liest den Befehl aus der Zeile.
  app.post(
    '/projects/:slug/test-evidence/:id/run',
    access({ role: 'run', tenant: 'project' }),
    async (request, response, next) => {
      try {
        const slug = parseProjectSlug(request.params.slug ?? '');
        const id = request.params.id ?? '';
        if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
        if (!isUuid(id)) return void response.status(400).json({ message: 'Ungültiger Nachweis.' });
        const problem = evidenceBodyProblem(request.body);
        if (problem) return void response.status(400).json({ message: problem });
        const evidence = (
          await pool.query<{ befehl: string; grund: string; status: string }>(
            `SELECT e.befehl, e.grund, e.status FROM test_evidence e JOIN development_items d ON d.id = e.development_id
              WHERE e.id = $1 AND d.project_slug = $2`,
            [id, slug],
          )
        ).rows[0];
        if (!evidence) return void response.status(404).json({ message: 'Testnachweis nicht gefunden.' });
        if (evidence.status === 'passed')
          return void response.status(409).json({ message: 'Der Nachweis ist schon erbracht.' });
        if (evidence.grund === 'nicht_freigegeben' || evidence.status === 'nicht_freigegeben')
          return void response
            .status(422)
            .json({ message: 'Befehl nicht freigegeben – Rechte-Gruppen des Agents anpassen.' });
        if (!isAllowedCommand(evidence.befehl)) {
          await pool.query(`UPDATE test_evidence SET status = 'nicht_freigegeben' WHERE id = $1`, [id]);
          return void response
            .status(422)
            .json({ message: 'Befehl nicht freigegeben – Rechte-Gruppen des Agents anpassen.' });
        }
        const open = (
          await pool.query(
            `SELECT ${COLUMNS} FROM test_requests WHERE project_slug = $1 AND status IN ('requested', 'running')`,
            [slug],
          )
        ).rows[0];
        if (open)
          return void response.status(409).json({ message: 'Ein kompletter Test läuft bereits.', request: open });
        const created = (
          await pool
            .query(
              `INSERT INTO test_requests (project_slug, scope, requested_by, comment, evidence_id)
               VALUES ($1, 'befehl', $2, $3, $4) RETURNING ${COLUMNS}, evidence_id AS "evidenceId"`,
              [
                slug,
                me(response)?.displayName ?? null,
                isRecord(request.body) && typeof request.body.comment === 'string'
                  ? request.body.comment.trim().slice(0, 2000) || null
                  : null,
                id,
              ],
            )
            .catch((error: unknown) => {
              // Gleichzeitig angefordert: der eindeutige Index für offene Anfragen greift.
              if ((error as { code?: string }).code === '23505') return { rows: [] };
              throw error;
            })
        ).rows[0];
        if (!created) return void response.status(409).json({ message: 'Ein kompletter Test läuft bereits.' });
        response.status(201).json({ request: created });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get('/projects/:slug/test-requests', access({ tenant: 'project' }), async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
      const requests = (
        await pool.query(
          `SELECT ${COLUMNS} FROM test_requests WHERE project_slug = $1 ORDER BY created_at DESC LIMIT 5`,
          [slug],
        )
      ).rows;
      response.json({ requests });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    '/projects/:slug/test-requests',
    access({ role: 'run', tenant: 'project' }),
    async (request, response, next) => {
      try {
        const slug = parseProjectSlug(request.params.slug ?? '');
        const scope = parseScope(request.body);
        if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
        if (!scope) return void response.status(400).json({ message: 'Umfang muss „full“ oder „ui“ sein.' });
        const open = (
          await pool.query(
            `SELECT ${COLUMNS} FROM test_requests WHERE project_slug = $1 AND status IN ('requested', 'running')`,
            [slug],
          )
        ).rows[0];
        if (open)
          return void response.status(409).json({ message: 'Ein kompletter Test läuft bereits.', request: open });
        const created = (
          await pool.query(
            `INSERT INTO test_requests (project_slug, scope, requested_by, comment)
           SELECT slug, $2, $3, $4 FROM projects WHERE slug = $1 RETURNING ${COLUMNS}`,
            [
              slug,
              scope,
              me(response)?.displayName ?? null,
              isRecord(request.body) && typeof request.body.comment === 'string'
                ? request.body.comment.trim().slice(0, 2000) || null
                : null,
            ],
          )
        ).rows[0];
        if (!created) return void response.status(404).json({ message: 'Projekt nicht gefunden.' });
        response.status(201).json({ request: created });
      } catch (error) {
        next(error);
      }
    },
  );
}
