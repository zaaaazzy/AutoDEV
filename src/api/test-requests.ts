import type { Router, Response } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import { isRecord, parseProjectSlug } from '../core/validation.js';
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

export function registerTestRequestRoutes(app: Router, pool: Pool): void {
  const me = (response: Response) => response.locals.principal as Principal | undefined;

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
