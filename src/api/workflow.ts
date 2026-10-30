import type { Router } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import { isRecord, isUuid, parseProjectSlug } from '../core/validation.js';
import { PHASE_SET, PHASE_SQL_ORDER } from '../core/workflow-phases.js';
import { assertInProject } from './tenancy.js';

export const STEP_COLUMNS = `id, phase, position, agent_id AS "agentId", instructions, enabled`;
const MAX_INSTRUCTIONS = 10_000;

/**
 * Workflow eines Projekts als Schritte. Gibt es noch keine (ältere Projekte), wird der bisherige Ablauf aus den
 * Agents übernommen: ein Schritt je Agent mit dessen Phase und Position.
 */
export async function ensureWorkflowSteps(pool: Pool, slug: string): Promise<void> {
  await pool.query(
    `INSERT INTO workflow_steps (project_slug, phase, position, agent_id, enabled)
     SELECT project_slug, phase, position, id, enabled FROM agents
      WHERE project_slug = $1 AND NOT EXISTS (SELECT 1 FROM workflow_steps WHERE project_slug = $1)`,
    [slug],
  );
}

export async function loadWorkflowSteps(pool: Pool, slug: string): Promise<unknown[]> {
  return (
    await pool.query(
      `SELECT ${STEP_COLUMNS} FROM workflow_steps WHERE project_slug = $1 ORDER BY ${PHASE_SQL_ORDER}, position, created_at`,
      [slug],
    )
  ).rows;
}

export function registerWorkflowRoutes(app: Router, pool: Pool): void {
  app.get('/projects/:slug/workflow', access({ tenant: 'project' }), async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
      await ensureWorkflowSteps(pool, slug);
      response.json({ steps: await loadWorkflowSteps(pool, slug) });
    } catch (error) {
      next(error);
    }
  });

  // „+“: Agent (auch mehrfach) an das Ende einer Phase setzen, optional mit Anweisung für diesen Einsatz.
  app.post(
    '/projects/:slug/workflow/steps',
    access({ role: 'agents', tenant: 'project' }),
    async (request, response, next) => {
      try {
        const slug = parseProjectSlug(request.params.slug ?? '');
        const body = request.body as unknown;
        const instructions = isRecord(body) && typeof body.instructions === 'string' ? body.instructions.trim() : '';
        if (
          !slug ||
          !isRecord(body) ||
          typeof body.phase !== 'string' ||
          !PHASE_SET.has(body.phase) ||
          !isUuid(body.agentId) ||
          instructions.length > MAX_INSTRUCTIONS
        ) {
          return void response.status(400).json({ message: 'Ungültiger Workflow-Schritt.' });
        }
        // Vor ensureWorkflowSteps: Eine abgelehnte Anfrage darf auch die Standard-Schritte nicht anlegen.
        if (!(await assertInProject(pool, 'agents', body.agentId as string, slug))) {
          return void response.status(400).json({ message: 'Agent gehört nicht zum Projekt.' });
        }
        await ensureWorkflowSteps(pool, slug);
        const result = await pool.query(
          `INSERT INTO workflow_steps (project_slug, phase, position, agent_id, instructions)
         SELECT $1, $2, COALESCE((SELECT MAX(position) FROM workflow_steps WHERE project_slug = $1 AND phase = $2), 0) + 1,
                a.id, $4
           FROM agents a WHERE a.id = $3 AND a.project_slug = $1
         RETURNING ${STEP_COLUMNS}`,
          [slug, body.phase, body.agentId, instructions],
        );
        if (!result.rows[0]) return void response.status(400).json({ message: 'Agent gehört nicht zum Projekt.' });
        response.status(201).json({ step: result.rows[0] });
      } catch (error) {
        next(error);
      }
    },
  );

  // Reihenfolge einer Phase; Schritte aus anderen Phasen wechseln dabei in diese.
  app.post(
    '/projects/:slug/workflow/order',
    access({ role: 'agents', tenant: 'project' }),
    async (request, response, next) => {
      try {
        const slug = parseProjectSlug(request.params.slug ?? '');
        const body = request.body as unknown;
        if (
          !slug ||
          !isRecord(body) ||
          typeof body.phase !== 'string' ||
          !PHASE_SET.has(body.phase) ||
          !Array.isArray(body.ids) ||
          body.ids.length > 200 ||
          !body.ids.every(isUuid)
        ) {
          return void response.status(400).json({ message: 'Ungültige Reihenfolge.' });
        }
        if (!(await assertInProject(pool, 'workflow_steps', body.ids as string[], slug))) {
          return void response.status(400).json({ message: 'Schritte gehören nicht zu diesem Projekt.' });
        }
        await pool.query(
          `UPDATE workflow_steps s SET position = o.ord, phase = $2
           FROM unnest($3::uuid[]) WITH ORDINALITY AS o(id, ord)
          WHERE s.id = o.id AND s.project_slug = $1`,
          [slug, body.phase, body.ids],
        );
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

  app.patch(
    '/workflow-steps/:id',
    access({ role: 'agents', tenant: 'workflow-steps' }),
    async (request, response, next) => {
      try {
        const body = request.body as unknown;
        if (!isUuid(request.params.id) || !isRecord(body))
          return void response.status(400).json({ message: 'Ungültig.' });
        const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : undefined;
        const enabled = typeof body.enabled === 'boolean' ? body.enabled : undefined;
        if ((instructions === undefined && enabled === undefined) || (instructions?.length ?? 0) > MAX_INSTRUCTIONS) {
          return void response.status(400).json({ message: 'Ungültige Änderung.' });
        }
        const result = await pool.query(
          `UPDATE workflow_steps SET instructions = COALESCE($2, instructions), enabled = COALESCE($3, enabled)
          WHERE id = $1 RETURNING ${STEP_COLUMNS}`,
          [request.params.id, instructions ?? null, enabled ?? null],
        );
        if (!result.rows[0]) return void response.status(404).json({ message: 'Schritt nicht gefunden.' });
        response.json({ step: result.rows[0] });
      } catch (error) {
        next(error);
      }
    },
  );

  app.delete(
    '/workflow-steps/:id',
    access({ role: 'agents', tenant: 'workflow-steps' }),
    async (request, response, next) => {
      try {
        if (!isUuid(request.params.id)) return void response.status(404).json({ message: 'Schritt nicht gefunden.' });
        await pool.query('DELETE FROM workflow_steps WHERE id = $1', [request.params.id]);
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );
}
