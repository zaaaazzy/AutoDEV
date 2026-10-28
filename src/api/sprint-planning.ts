import type { Router } from 'express';
import type { Pool, PoolClient } from 'pg';
import { access } from './access.js';
import {
  affectedFiles,
  type Capacity,
  capacityFrom,
  type PlanCandidate,
  type PlannedItem,
  planRoadmap,
  proposeSprint,
  type SprintProposal,
} from '../core/sprint-planner.js';
import {
  calibratedHours,
  calibratedTokens,
  type CalibrationFactor,
  ESTIMATE_SOURCE_LABELS,
  ESTIMATE_SOURCES,
  type EstimateSource,
  loadCalibration,
  sourceOf,
} from '../core/estimate-calibration.js';
import { isRecord, isUuid, parseProjectSlug } from '../core/validation.js';
import { describeWorkingHours, type WorkingHours, withinWorkingHours } from '../core/working-hours.js';
import { generateSprintReport } from './reports.js';
import { guardGit } from './git-state.js';
import { completedSprintUsage, costOfTokens, tokenPriceUsd } from './usage.js';

/** Modus der Sprintplanung je Projekt: manuell (Standard), vorschlagen, Autopilot. */
export const SPRINT_MODES = ['manual', 'suggest', 'autopilot'] as const;
export type SprintMode = (typeof SPRINT_MODES)[number];
export const DEFAULT_CAPACITY_HOURS = 4;
export const ROADMAP_SPRINTS = 3;

/**
 * Zustand des Autopilots: aus, pausiert (Git-Sicherung des letzten Sprints gescheitert, bis zur Freigabe),
 * Abschluss läuft noch, ausserhalb der Arbeitszeiten oder bereit.
 */
export interface AutopilotGuard {
  state: 'off' | 'paused' | 'finishing' | 'outside_hours' | 'ready';
  message: string | null;
  workingHours: WorkingHours;
  /** Sprint, dessen Git-Fehler den Autopilot anhält (für die Freigabe). */
  failedSprintId: string | null;
  /** Fertige Sprints selbst live schalten statt auf das Go zu warten (Projekteinstellung). */
  autoLive: boolean;
}

/** Kalibrierung einer Herkunft, die unter den Kandidaten vorkommt (für die Anzeige auf der Vorschlagskarte). */
export interface CalibrationSummary extends CalibrationFactor {
  source: EstimateSource;
  label: string;
}

export interface LoadedProposal extends SprintProposal {
  mode: SprintMode;
  name: string;
  totals: { hours: number; tokens: number; costUsd: number | null };
  /** Durchschnittspreis je Token aus den gemessenen Kosten; null ohne Messwerte. */
  tokenPriceUsd: number | null;
  calibration: CalibrationSummary[];
  autopilot: AutopilotGuard;
}

interface PlanningInput {
  mode: SprintMode;
  sprintCount: number;
  candidates: PlanCandidate[];
  done: Set<string>;
  capacity: Capacity;
  tokenPriceUsd: number | null;
  calibration: CalibrationSummary[];
}

/** Offene Aufträge ausserhalb eines laufenden oder geplanten Sprints sind Kandidaten; „Aktion notwendig“ wird übernommen. */
async function loadPlanningInput(pool: Pool, project: string): Promise<PlanningInput | null> {
  const settings = (
    await pool.query<{ mode: SprintMode; capacity: number | null; sprints: string }>(
      `SELECT sprint_mode AS mode, sprint_capacity_hours AS capacity,
              -- Höchste Sprint-Nummer statt Anzahl: nach gelöschten Sprints entstanden sonst doppelte Namen (und Branches).
              (SELECT GREATEST(COUNT(*), COALESCE(MAX(substring(name FROM '^Sprint ([0-9]+)$')::int), 0))
                 FROM sprints WHERE project_slug = p.slug) AS sprints
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
      estimateSource: string | null;
      followUpOf: string | null;
      troubled: boolean;
      actionTodo: string | null;
    }>(
      `SELECT d.id, d.title, d.description, d.status, d.priority, d.kind, d.benefit, d.cost,
              d.effort_hours AS "effortHours", d.token_estimate AS "tokenEstimate",
              d.estimate_source AS "estimateSource", d.follow_up_of AS "followUpOf",
              (d.retry_count > 0 OR d.removed_from_sprint_at IS NOT NULL OR d.status = 'blocked') AS troubled,
              d.action_todo AS "actionTodo"
         FROM development_items d LEFT JOIN sprints s ON s.id = d.sprint_id
        WHERE d.project_slug = $1 AND d.status IN ('backlog', 'planned', 'blocked') AND d.kind <> 'express'
          AND (d.sprint_id IS NULL OR s.status = 'completed')
        ORDER BY d.created_at, d.id`,
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
  // Schätzungen auf gemessene Agent-Stunden und Tokens umrechnen; die Ist-Werte der letzten 3 Sprints nur zur Anzeige.
  const [history, price, calibration, sprintBudget] = await Promise.all([
    completedSprintUsage(pool, project, 3),
    tokenPriceUsd(pool, project),
    loadCalibration(pool, project),
    pool.query<{ maxTokens: string | null }>(
      `SELECT max_tokens AS "maxTokens" FROM budgets WHERE project_slug = $1 AND period = 'sprint'`,
      [project],
    ),
  ]);
  const sprintTokens = sprintBudget.rows[0]?.maxTokens;
  const used = new Set(rows.map((row) => sourceOf(row.estimateSource)));
  const candidates: PlanCandidate[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    priority: row.priority,
    kind: row.kind === 'bug' ? 'bug' : 'feature',
    benefit: row.benefit,
    cost: row.cost,
    effortHours: calibratedHours(row.effortHours, row.estimateSource, calibration),
    tokenEstimate: calibratedTokens(
      row.tokenEstimate === null ? null : Number(row.tokenEstimate),
      row.estimateSource,
      calibration,
    ),
    rawEffortHours: row.effortHours,
    followUpOf: row.followUpOf,
    troubled: row.troubled,
    // Nur „Aktion notwendig“ wartet auf einen Menschen und wandert fest mit; andere Blockierte werden normal bewertet.
    carryOver: row.status === 'blocked' && !!row.actionTodo,
    files: affectedFiles(row.description ?? ''),
  }));
  return {
    mode: settings.mode,
    sprintCount: Number(settings.sprints),
    candidates,
    done,
    capacity: capacityFrom(
      history,
      Number(settings.capacity ?? DEFAULT_CAPACITY_HOURS),
      sprintTokens === null || sprintTokens === undefined ? null : Number(sprintTokens),
    ),
    tokenPriceUsd: price,
    calibration: ESTIMATE_SOURCES.filter((source) => used.has(source)).map((source) => ({
      source,
      label: ESTIMATE_SOURCE_LABELS[source],
      ...calibration[source],
    })),
  };
}

/**
 * Was den Autopilot anhält: gescheiterte Git-Sicherung des letzten abgeschlossenen Sprints (bis zur Freigabe),
 * ein noch laufender Abschluss, ein Sprint, der noch nicht in main ist („wartet auf Merge“), und die Arbeitszeiten
 * (nur für das Starten neuer Sprints).
 * Budget: Der Autopilot prüft es (noch) nicht selbst; die Agent-Läufe, die er anstößt, halten die Budget-Limits
 * ein (src/runner/budget.ts). Eine eigene Prüfung hier ist ein eigener Auftrag.
 */
export async function autopilotGuard(pool: Pool, project: string, now = new Date()): Promise<AutopilotGuard | null> {
  const settings = (
    await pool.query<{
      mode: SprintMode;
      start: string;
      end: string;
      days: number[];
      released: string | null;
      autoLive: boolean | null;
    }>(
      `SELECT sprint_mode AS mode, autopilot_start AS start, autopilot_end AS "end", autopilot_days AS days,
              autopilot_released_sprint AS released, autopilot_auto_live AS "autoLive"
         FROM projects WHERE slug = $1`,
      [project],
    )
  ).rows[0];
  if (!settings) return null;
  const workingHours = { start: settings.start, end: settings.end, days: settings.days.map(Number) };
  const guard = (state: AutopilotGuard['state'], message: string | null, failedSprintId: string | null = null) => ({
    state,
    message,
    workingHours,
    failedSprintId,
    autoLive: settings.autoLive === true,
  });
  if (settings.mode !== 'autopilot') return guard('off', null);
  const last = (
    await pool.query<{ id: string; name: string; sync: string | null; message: string | null }>(
      `SELECT id, name, git_sync AS sync, git_message AS message FROM sprints
        WHERE project_slug = $1 AND status = 'completed'
        ORDER BY COALESCE(end_date, created_at::date) DESC, created_at DESC LIMIT 1`,
      [project],
    )
  ).rows[0];
  if (last?.sync === 'failed' && last.id !== settings.released) {
    return guard(
      'paused',
      `Autopilot pausiert: Abschluss von „${last.name}“ gescheitert (Merge/Git)${last.message ? ` – ${last.message.slice(0, 400)}` : ''}. ` +
        'Fehler beheben und die Git-Sicherung erneut starten oder den Autopilot freigeben.',
      last.id,
    );
  }
  if (last?.sync === 'pending' || last?.sync === 'running') {
    return guard('finishing', `Abschluss von „${last.name}“ läuft (Test-Gate, Merge, Push).`);
  }
  // Ein neuer Sprint zweigt von main ab: Solange main den letzten nicht enthält, arbeitete er ohne dessen Code.
  if (last?.sync === 'awaiting_merge') {
    return guard(
      'finishing',
      `„${last.name}“ ist noch nicht in main – wartet auf den Merge${last.message ? ` (${last.message.slice(0, 400)})` : ''}. ` +
        'Der nächste Sprint startet, sobald main den Sprint enthält.',
    );
  }
  // PR-Modus: Der nächste Sprint startet erst, wenn der Pull Request gemergt ist (sonst fehlt der Stand in main).
  const review = (
    await pool.query<{ name: string }>(
      `SELECT name FROM sprints WHERE project_slug = $1 AND status = 'review' ORDER BY updated_at LIMIT 1`,
      [project],
    )
  ).rows[0];
  if (review) {
    return guard('finishing', `Pull Request von „${review.name}“ wartet auf grüne CI bzw. Freigabe.`);
  }
  if (!withinWorkingHours(now, workingHours)) {
    return guard(
      'outside_hours',
      `Ausserhalb der Arbeitszeiten (${describeWorkingHours(workingHours)}): Der Autopilot startet keinen neuen Sprint.`,
    );
  }
  return guard('ready', null);
}

const withCost = (totals: { hours: number; tokens: number }, price: number | null) => ({
  ...totals,
  costUsd: costOfTokens(totals.tokens, price),
});

export async function loadProposal(pool: Pool, project: string): Promise<LoadedProposal | null> {
  const input = await loadPlanningInput(pool, project);
  const autopilot = input && (await autopilotGuard(pool, project));
  if (!input || !autopilot) return null;
  const proposal = proposeSprint(input.candidates, input.done, input.capacity);
  return {
    ...proposal,
    totals: withCost(proposal.totals, input.tokenPriceUsd),
    mode: input.mode,
    name: `Sprint ${input.sprintCount + 1}`,
    tokenPriceUsd: input.tokenPriceUsd,
    calibration: input.calibration,
    autopilot,
  };
}

export interface Roadmap {
  capacity: Capacity;
  tokenPriceUsd: number | null;
  sprints: { name: string; items: PlannedItem[]; totals: { hours: number; tokens: number; costUsd: number | null } }[];
}

/** Vorschau der nächsten 3 Sprints – nur berechnet, es wird nichts angelegt oder geändert. */
export async function loadRoadmap(pool: Pool, project: string): Promise<Roadmap | null> {
  const input = await loadPlanningInput(pool, project);
  if (!input) return null;
  return {
    capacity: input.capacity,
    tokenPriceUsd: input.tokenPriceUsd,
    sprints: planRoadmap(input.candidates, input.done, input.capacity, ROADMAP_SPRINTS).map((sprint, index) => ({
      name: `Sprint ${input.sprintCount + 1 + index}`,
      items: sprint.items,
      totals: withCost(sprint.totals, input.tokenPriceUsd),
    })),
  };
}

/**
 * Übernimmt einen Vorschlag: Sprint anlegen, Aufträge in der gegebenen Reihenfolge zuordnen (sprint_rank) und
 * optional starten. Nur Kandidaten des Projekts werden angenommen. Ein KI-Kommentar zum Vorschlag wird verworfen.
 */
export async function applyProposal(
  pool: Pool,
  project: string,
  ids: string[],
  start: boolean,
  /** Kommentar beim Übernehmen: wird das Sprintziel. */
  comment = '',
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
          comment.trim()
            ? `${comment.trim().slice(0, 2000)}\n\n(Vorschlag der Sprintplanung: ${ids.length} Aufträge)`
            : `Vorschlag der Sprintplanung: ${ids.length} Aufträge`,
          shouldStart ? 'active' : 'planned',
        ],
      )
    ).rows[0]!.id;
    // Blockierte Aufträge (z. B. aus einem gescheiterten Sprint) werden wie bei „In Sprint übernehmen“ zurückgesetzt:
    // Sonst landeten sie blockiert samt altem Vermerk im neuen Sprint, liefen nie und hielten ihn offen (Sprint 21).
    // auto_run folgt dem Sprint: ein geplanter wartet auf seinen Start.
    await client.query(
      `UPDATE development_items d
          SET sprint_id = $2, sprint_rank = picked.rank,
              status = CASE WHEN d.status IN ('backlog', 'blocked') THEN 'planned' ELSE d.status END,
              auto_run = $4,
              agent_id = CASE WHEN d.status = 'blocked' THEN NULL ELSE d.agent_id END,
              failure = CASE WHEN d.status = 'blocked' THEN NULL ELSE d.failure END,
              action_todo = CASE WHEN d.status = 'blocked' THEN NULL ELSE d.action_todo END,
              retry_after = CASE WHEN d.status = 'blocked' THEN NULL ELSE d.retry_after END,
              retry_count = d.retry_count + CASE WHEN d.status = 'blocked' THEN 1 ELSE 0 END,
              analysis_status = CASE WHEN d.status <> 'blocked' OR d.analysis_status IN ('requested', 'running')
                                     THEN d.analysis_status ELSE NULL END,
              budget_since = CASE WHEN d.status = 'blocked' THEN NOW() ELSE d.budget_since END,
              removed_from_sprint = NULL, removed_from_sprint_at = NULL, updated_at = NOW()
         FROM unnest($1::uuid[]) WITH ORDINALITY AS picked(id, rank)
        WHERE d.id = picked.id AND d.project_slug = $3`,
      [ids, sprintId, project, shouldStart],
    );
    await client.query('DELETE FROM sprint_proposal_comments WHERE project_slug = $1', [project]);
    await client.query('COMMIT');
    return { sprintId, started: shouldStart };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Sprint abschliessen: Bericht, danach testet, merged und pusht der Worker (Git-Sicherung). Alles in einer
 * Transaktion – scheitert ein Schritt, bleibt der Sprint im alten Status (kein „abgeschlossen ohne Bericht“).
 * Idempotent: Der Statuswechsel ist an einen aktiven, nicht pausierten Sprint gebunden; war der Sprint schon
 * abgeschlossen (zweiter Lauf, Oberfläche), passiert nichts und das Ergebnis ist false.
 */
export async function completeSprint(pool: Pool, sprintId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claimed = await client.query(
      `UPDATE sprints SET status = 'completed' WHERE id = $1 AND status = 'active' AND paused_at IS NULL RETURNING id`,
      [sprintId],
    );
    if (!claimed.rows[0]) {
      await client.query('ROLLBACK');
      return false;
    }
    await completeSprintIn(client, sprintId);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Abschluss innerhalb einer schon offenen Transaktion des Aufrufers (z. B. zusammen mit dem Status-PATCH). */
export async function completeSprintIn(client: PoolClient, sprintId: string): Promise<void> {
  await client.query(
    // Ein vorzeitig gestarteter Sprint hat ein Startdatum in der Zukunft: das Ende nie davor legen (CHECK end >= start).
    `UPDATE sprints SET status = 'completed', end_date = COALESCE(end_date, GREATEST(start_date, CURRENT_DATE))
      WHERE id = $1`,
    [sprintId],
  );
  await generateSprintReport(client, sprintId);
  await client.query(
    `UPDATE sprints SET git_sync = 'pending', git_action = 'push', git_message = NULL
      WHERE id = $1 AND (git_sync IS NULL OR git_sync IN ('done', 'failed'))`,
    [sprintId],
  );
}

const parseIds = (body: unknown): string[] | null =>
  isRecord(body) &&
  Array.isArray(body.ids) &&
  body.ids.length > 0 &&
  body.ids.length <= 200 &&
  body.ids.every((id) => isUuid(id))
    ? (body.ids as string[])
    : null;

export function registerSprintPlanningRoutes(app: Router, pool: Pool): void {
  app.get('/projects/:slug/sprints/proposal', access({ tenant: 'project' }), async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      const proposal = slug ? await loadProposal(pool, slug) : null;
      if (!proposal) return void response.status(404).json({ message: 'Projekt nicht gefunden.' });
      response.json({ proposal });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    '/projects/:slug/sprints/proposal/apply',
    access({ role: 'plan', tenant: 'project' }),
    async (request, response, next) => {
      try {
        const slug = parseProjectSlug(request.params.slug ?? '');
        const ids = parseIds(request.body);
        if (!slug || !ids) return void response.status(400).json({ message: 'Aufträge auswählen.' });
        const body = isRecord(request.body) ? request.body : {};
        const comment = typeof body.comment === 'string' ? body.comment : '';
        if (body.start === true && !(await guardGit(pool, slug, 'sprint_start', body, response))) return;
        const result = await applyProposal(pool, slug, ids, body.start === true, comment);
        if (typeof result === 'string') return void response.status(400).json({ message: result });
        response.status(201).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  app.get('/projects/:slug/sprints/roadmap', access({ tenant: 'project' }), async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      const roadmap = slug ? await loadRoadmap(pool, slug) : null;
      if (!roadmap) return void response.status(404).json({ message: 'Projekt nicht gefunden.' });
      response.json({ roadmap });
    } catch (error) {
      next(error);
    }
  });

  // KI-Kommentar: der Worker lässt den Auftragsautor den Vorschlag kommentieren (nur Text, ändert die Auswahl nicht).
  app.get(
    '/projects/:slug/sprints/proposal/comment',
    access({ tenant: 'project' }),
    async (request, response, next) => {
      try {
        const slug = parseProjectSlug(request.params.slug ?? '');
        if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
        const comment = (
          await pool.query(
            `SELECT item_ids AS "itemIds", status, comment, requested_at AS "requestedAt", finished_at AS "finishedAt"
             FROM sprint_proposal_comments WHERE project_slug = $1`,
            [slug],
          )
        ).rows[0];
        response.json({ comment: comment ?? null });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    '/projects/:slug/sprints/proposal/comment',
    access({ role: 'plan', tenant: 'project' }),
    async (request, response, next) => {
      try {
        const slug = parseProjectSlug(request.params.slug ?? '');
        const ids = parseIds(request.body);
        if (!slug || !ids) return void response.status(400).json({ message: 'Aufträge auswählen.' });
        const proposal = await loadProposal(pool, slug);
        if (!proposal) return void response.status(404).json({ message: 'Projekt nicht gefunden.' });
        const allowed = new Set(proposal.items.map((item) => item.id));
        if (ids.some((id) => !allowed.has(id)))
          return void response.status(400).json({ message: 'Nur vorgeschlagene Aufträge lassen sich kommentieren.' });
        const comment = (
          await pool.query(
            `INSERT INTO sprint_proposal_comments (project_slug, item_ids, status) VALUES ($1, $2, 'requested')
           ON CONFLICT (project_slug) DO UPDATE
             SET item_ids = EXCLUDED.item_ids, status = 'requested', comment = NULL, requested_at = NOW(),
                 finished_at = NULL
           WHERE sprint_proposal_comments.status NOT IN ('requested', 'running')
           RETURNING item_ids AS "itemIds", status, comment`,
            [slug, ids],
          )
        ).rows[0];
        if (!comment) return void response.status(409).json({ message: 'Der Kommentar wird schon geschrieben.' });
        response.status(202).json({ comment });
      } catch (error) {
        next(error);
      }
    },
  );

  // Manuelle Freigabe nach gescheitertem Abschluss: der Fehler dieses Sprints hält den Autopilot nicht mehr an.
  app.post(
    '/projects/:slug/sprints/autopilot/resume',
    access({ role: 'plan', tenant: 'project' }),
    async (request, response, next) => {
      try {
        const slug = parseProjectSlug(request.params.slug ?? '');
        const guard = slug ? await autopilotGuard(pool, slug) : null;
        if (!slug || !guard) return void response.status(404).json({ message: 'Projekt nicht gefunden.' });
        if (guard.state !== 'paused' || !guard.failedSprintId)
          return void response.status(400).json({ message: 'Der Autopilot ist nicht pausiert.' });
        await pool.query('UPDATE projects SET autopilot_released_sprint = $2 WHERE slug = $1', [
          slug,
          guard.failedSprintId,
        ]);
        response.json({ resumed: true });
      } catch (error) {
        next(error);
      }
    },
  );
}
