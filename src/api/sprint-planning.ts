import type { Express } from 'express';
import type { Pool } from 'pg';
import {
  affectedFiles,
  capacityFrom,
  type PlanCandidate,
  proposeSprint,
  type SprintProposal,
} from '../core/sprint-planner.js';
import { isRecord, isUuid, parseProjectSlug } from '../core/validation.js';
import { generateSprintReport } from './reports.js';

/** Modus der Sprintplanung je Projekt: manuell (Standard), vorschlagen, Autopilot. */
export const SPRINT_MODES = ['manual', 'suggest', 'autopilot'] as const;
export type SprintMode = (typeof SPRINT_MODES)[number];
export const DEFAULT_CAPACITY_HOURS = 40;

export interface LoadedProposal extends SprintProposal {
  mode: SprintMode;
  name: string;
}

/** Offene Aufträge ausserhalb eines laufenden oder geplanten Sprints sind Kandidaten; „Aktion notwendig“ wird übernommen. */
export async function loadProposal(pool: Pool, project: string): Promise<LoadedProposal | null> {
  const settings = (
    await pool.query<{ mode: SprintMode; capacity: number | null; sprints: string }>(
      `SELECT sprint_mode AS mode, sprint_capacity_hours AS capacity,
              (SELECT COUNT(*) FROM sprints WHERE project_slug = p.slug) AS sprints
         FROM projects p WHERE slug = $1`,
      [project],
    )
  ).rows[0];
  if (!settings) return null;
  const rows = (
    await pool.query<{
      id: string;
      title: string;
      description: string;
      status: string;
      priority: PlanCandidate['priority'];
      kind: PlanCandidate['kind'] | null;
      benefit: number | null;
      cost: number | null;
      effortHours: number | null;
      tokenEstimate: string | null;
      followUpOf: string | null;
      troubled: boolean;
    }>(
      `SELECT d.id, d.title, d.description, d.status, d.priority, d.kind, d.benefit, d.cost,
              d.effort_hours AS "effortHours", d.token_estimate AS "tokenEstimate", d.follow_up_of AS "followUpOf",
              (d.retry_count > 0 OR d.removed_from_sprint_at IS NOT NULL OR d.status = 'blocked') AS troubled
         FROM development_items d LEFT JOIN sprints s ON s.id = d.sprint_id
        WHERE d.project_slug = $1 AND d.status IN ('backlog', 'planned', 'blocked')
          AND (d.sprint_id IS NULL OR s.status = 'completed')`,
      [project],
    )
  ).rows;
  const done = new Set(
    (
      await pool.query<{ id: string }>(`SELECT id FROM development_items WHERE project_slug = $1 AND status = 'done'`, [
        project,
      ])
    ).rows.map((row) => row.id),
  );
  // Ist-Werte statt Schätzungen: erledigter Aufwand der letzten abgeschlossenen Sprints.
  const history = (
    await pool.query<{ hours: number; tokens: string }>(
      `SELECT COALESCE(SUM(d.effort_hours) FILTER (WHERE d.status = 'done'), 0) AS hours,
              COALESCE(SUM(d.token_estimate) FILTER (WHERE d.status = 'done'), 0) AS tokens
         FROM sprints s LEFT JOIN development_items d ON d.sprint_id = s.id
        WHERE s.project_slug = $1 AND s.status = 'completed'
        GROUP BY s.id ORDER BY MAX(COALESCE(s.end_date, s.created_at::date)) DESC, MAX(s.created_at) DESC LIMIT 3`,
      [project],
    )
  ).rows.map((row) => ({ hours: Number(row.hours), tokens: Number(row.tokens) }));
  const candidates: PlanCandidate[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    priority: row.priority,
    kind: row.kind === 'bug' ? 'bug' : 'feature',
    benefit: row.benefit,
    cost: row.cost,
    effortHours: row.effortHours,
    tokenEstimate: row.tokenEstimate === null ? null : Number(row.tokenEstimate),
    followUpOf: row.followUpOf,
    troubled: row.troubled,
    carryOver: row.status === 'blocked',
    files: affectedFiles(row.description ?? ''),
  }));
  const proposal = proposeSprint(
    candidates,
    done,
    capacityFrom(history, Number(settings.capacity ?? DEFAULT_CAPACITY_HOURS)),
  );
  return { ...proposal, mode: settings.mode, name: `Sprint ${Number(settings.sprints) + 1}` };
}

/**
 * Übernimmt einen Vorschlag: Sprint anlegen, Aufträge in der gegebenen Reihenfolge zuordnen (sprint_rank) und
 * optional starten. Nur Kandidaten des Projekts werden angenommen.
 */
export async function applyProposal(
  pool: Pool,
  project: string,
  ids: string[],
  start: boolean,
): Promise<{ sprintId: string; started: boolean } | string> {
  const proposal = await loadProposal(pool, project);
  if (!proposal) return 'Projekt nicht gefunden.';
  const allowed = new Set(proposal.items.map((item) => item.id));
  if (!ids.length || ids.some((id) => !allowed.has(id))) return 'Nur vorgeschlagene Aufträge lassen sich übernehmen.';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const active = (
      await client.query('SELECT 1 FROM sprints WHERE project_slug = $1 AND status = $2', [project, 'active'])
    ).rows[0];
    const shouldStart = start && !active;
    const sprintId = (
      await client.query<{ id: string }>(
        `INSERT INTO sprints (project_slug, name, goal, status, start_date)
         VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'active' THEN CURRENT_DATE END) RETURNING id`,
        [
          project,
          proposal.name,
          `Vorschlag der Sprintplanung: ${ids.length} Aufträge`,
          shouldStart ? 'active' : 'planned',
        ],
      )
    ).rows[0]!.id;
    await client.query(
      `UPDATE development_items d
          SET sprint_id = $2, sprint_rank = picked.rank,
              status = CASE WHEN d.status = 'backlog' THEN 'planned' ELSE d.status END,
              removed_from_sprint = NULL, removed_from_sprint_at = NULL, updated_at = NOW()
         FROM unnest($1::uuid[]) WITH ORDINALITY AS picked(id, rank)
        WHERE d.id = picked.id AND d.project_slug = $3`,
      [ids, sprintId, project],
    );
    await client.query('COMMIT');
    return { sprintId, started: shouldStart };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Sprint abschliessen: Bericht, danach testet, merged und pusht der Worker (Git-Sicherung). */
export async function completeSprint(pool: Pool, sprintId: string): Promise<void> {
  await pool.query(
    `UPDATE sprints SET status = 'completed', end_date = COALESCE(end_date, CURRENT_DATE) WHERE id = $1`,
    [sprintId],
  );
  await generateSprintReport(pool, sprintId);
  await pool.query(
    `UPDATE sprints SET git_sync = 'pending', git_action = 'push', git_message = NULL
      WHERE id = $1 AND (git_sync IS NULL OR git_sync IN ('done', 'failed'))`,
    [sprintId],
  );
}

export function registerSprintPlanningRoutes(app: Express, pool: Pool): void {
  app.get('/api/projects/:slug/sprints/proposal', async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      const proposal = slug ? await loadProposal(pool, slug) : null;
      if (!proposal) return void response.status(404).json({ message: 'Projekt nicht gefunden.' });
      response.json({ proposal });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/projects/:slug/sprints/proposal/apply', async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      const body = request.body as unknown;
      if (
        !slug ||
        !isRecord(body) ||
        !Array.isArray(body.ids) ||
        body.ids.length > 200 ||
        !body.ids.every((id) => isUuid(id))
      ) {
        return void response.status(400).json({ message: 'Aufträge auswählen.' });
      }
      const result = await applyProposal(pool, slug, body.ids as string[], body.start === true);
      if (typeof result === 'string') return void response.status(400).json({ message: result });
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });
}
