import type { Router } from 'express';
import type { Pool } from 'pg';
import { isUuid } from '../core/validation.js';
import { ANSWERED } from './chat-routes.js';

export interface TimelineEntry {
  at: string;
  kind: 'created' | 'status' | 'step' | 'analysis' | 'question' | 'answer' | 'bugfix';
  title: string;
  detail?: string;
  state?: 'passed' | 'failed' | 'running' | 'info';
  /** Nur bei Rückfragen: schon beantwortet (die Oberfläche blendet erledigte Rückfragen aus). */
  answered?: boolean;
}

export interface WaitingState {
  status: string;
  kind: string;
  autoRun: boolean;
  actionTodo: string | null;
  analysisStatus: string | null;
  sprintStatus: string | null;
  runningAgent: string | null;
  openQuestion: boolean;
  bugfix: { title: string; status: string } | null;
}

const STATUS_LABEL: Record<string, string> = {
  backlog: 'Backlog',
  planned: 'Geplant',
  in_progress: 'In Arbeit',
  blocked: 'Blockiert',
  done: 'Erledigt',
  rejected: 'Abgelehnt',
};

export const statusLabel = (status: string): string => STATUS_LABEL[status] ?? status;

const ANALYSIS_LABEL: Record<string, string> = {
  requested: 'Problemanalyse angefordert',
  running: 'Problemanalyse läuft',
  done: 'Problemanalyse abgeschlossen',
  failed: 'Problemanalyse gescheitert',
};

/** Worauf der Auftrag gerade wartet – in einem Satz, für die Kopfzeile der Zeitleiste. */
export function waitingFor(state: WaitingState): { label: string; tone: 'ok' | 'wait' | 'you' | 'problem' } {
  switch (state.status) {
    case 'done':
      return { label: 'Erledigt', tone: 'ok' };
    case 'rejected':
      return { label: 'Abgelehnt – wird nicht umgesetzt', tone: 'problem' };
    case 'in_progress':
      return { label: state.runningAgent ? `Läuft: ${state.runningAgent}` : 'Läuft', tone: 'ok' };
    case 'backlog':
      return { label: 'Wartet auf Einplanung in einen Sprint', tone: 'wait' };
    case 'planned':
      if (state.autoRun || state.sprintStatus === 'active')
        return { label: 'Wartet auf einen freien Platz im Worker', tone: 'wait' };
      return { label: 'Wartet auf den Start des Sprints', tone: 'wait' };
    case 'blocked':
      if (state.openQuestion) return { label: 'Wartet auf deine Antwort', tone: 'you' };
      if (state.analysisStatus === 'requested' || state.analysisStatus === 'running')
        return { label: 'Wartet auf die Problemanalyse', tone: 'wait' };
      if (state.bugfix && !['done', 'rejected'].includes(state.bugfix.status))
        return { label: `Wartet auf den Bugfix „${state.bugfix.title}“`, tone: 'wait' };
      if (state.actionTodo) return { label: `Aktion notwendig: ${state.actionTodo}`, tone: 'you' };
      return { label: 'Wartet auf „Erneut versuchen“', tone: 'you' };
    default:
      return { label: statusLabel(state.status), tone: 'wait' };
  }
}

interface EventRow {
  at: Date;
  kind: string;
  detail: string;
}

/** Statuswechsel und Analyse-Ereignisse in lesbare Einträge übersetzen. */
export function describeEvent(row: EventRow): TimelineEntry {
  const at = row.at.toISOString();
  if (row.kind === 'created') return { at, kind: 'created', title: `Angelegt (${statusLabel(row.detail)})` };
  if (row.kind === 'analysis')
    return {
      at,
      kind: 'analysis',
      title: ANALYSIS_LABEL[row.detail] ?? `Problemanalyse: ${row.detail}`,
      state: row.detail === 'failed' ? 'failed' : 'info',
    };
  const [from = '', to = ''] = row.detail.split('>');
  return {
    at,
    kind: 'status',
    title: `${statusLabel(from)} → ${statusLabel(to)}`,
    state: to === 'done' ? 'passed' : to === 'blocked' || to === 'rejected' ? 'failed' : 'info',
  };
}

const formatDuration = (ms: number | null): string | undefined => {
  if (!ms || ms < 1000) return undefined;
  const seconds = Math.round(ms / 1000);
  return seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
};

export async function loadTimeline(
  pool: Pool,
  id: string,
): Promise<{ waiting: ReturnType<typeof waitingFor>; entries: TimelineEntry[] } | null> {
  const item = (
    await pool.query<{
      status: string;
      kind: string;
      autoRun: boolean;
      actionTodo: string | null;
      analysisStatus: string | null;
      failureBugId: string | null;
      sprintStatus: string | null;
      createdAt: Date;
    }>(
      `SELECT d.status, d.kind, d.auto_run AS "autoRun", d.action_todo AS "actionTodo",
              d.analysis_status AS "analysisStatus", d.failure_bug_id AS "failureBugId",
              s.status AS "sprintStatus", d.created_at AS "createdAt"
         FROM development_items d LEFT JOIN sprints s ON s.id = d.sprint_id
        WHERE d.id = $1`,
      [id],
    )
  ).rows[0];
  if (!item) return null;
  const [events, steps, bugfix, chat] = await Promise.all([
    pool.query<EventRow>(
      `SELECT at, kind, detail FROM development_events WHERE development_id = $1 ORDER BY at, id LIMIT 300`,
      [id],
    ),
    pool.query<{
      agentName: string;
      status: string;
      durationMs: number | null;
      startedAt: Date;
      lastEvent: string | null;
    }>(
      `SELECT s.agent_name AS "agentName", s.status, s.duration_ms AS "durationMs",
              COALESCE((s.events->0->>'at')::timestamptz, r.started_at) AS "startedAt",
              s.events->-1->>'text' AS "lastEvent"
         FROM agent_run_steps s JOIN agent_runs r ON r.id = s.run_id
        WHERE r.development_id = $1
        ORDER BY r.started_at, s.position LIMIT 300`,
      [id],
    ),
    item.failureBugId
      ? pool.query<{ title: string; status: string; createdAt: Date }>(
          `SELECT title, status, created_at AS "createdAt" FROM development_items WHERE bug_id = $1 LIMIT 1`,
          [item.failureBugId],
        )
      : Promise.resolve({ rows: [] as { title: string; status: string; createdAt: Date }[] }),
    pool.query<{ role: string; question: string | null; content: string; createdAt: Date; open: boolean }>(
      `SELECT m.role, m.question, m.content, m.created_at AS "createdAt",
              (m.role = 'assistant' AND m.question IS NOT NULL AND NOT ${ANSWERED}) AS open
         FROM chat_messages m
        WHERE m.development_id = $1 AND ((m.role = 'assistant' AND m.question IS NOT NULL) OR m.reply_to IS NOT NULL)
        ORDER BY m.created_at LIMIT 100`,
      [id],
    ),
  ]);
  const entries: TimelineEntry[] = events.rows.map(describeEvent);
  if (!entries.some((entry) => entry.kind === 'created'))
    entries.unshift({ at: item.createdAt.toISOString(), kind: 'created', title: 'Angelegt' });
  for (const step of steps.rows) {
    entries.push({
      at: new Date(step.startedAt).toISOString(),
      kind: 'step',
      title: step.agentName,
      detail: [formatDuration(step.durationMs), step.lastEvent ?? undefined].filter(Boolean).join(' · ') || undefined,
      state: step.status === 'passed' ? 'passed' : step.status === 'running' ? 'running' : 'failed',
    });
  }
  const fix = bugfix.rows[0] ?? null;
  if (fix)
    entries.push({
      at: fix.createdAt.toISOString(),
      kind: 'bugfix',
      title: `Bugfix-Auftrag „${fix.title}“`,
      detail: statusLabel(fix.status),
      state: fix.status === 'done' ? 'passed' : 'info',
    });
  for (const message of chat.rows) {
    entries.push(
      message.role === 'assistant'
        ? {
            at: message.createdAt.toISOString(),
            kind: 'question',
            title: 'Rückfrage',
            detail: message.question ?? '',
            answered: !message.open,
          }
        : {
            at: message.createdAt.toISOString(),
            kind: 'answer',
            title: 'Antwort',
            detail: message.content.slice(0, 200),
          },
    );
  }
  entries.sort((left, right) => left.at.localeCompare(right.at));
  const running = [...steps.rows].reverse().find((step) => step.status === 'running');
  const waiting = waitingFor({
    status: item.status,
    kind: item.kind,
    autoRun: item.autoRun,
    actionTodo: item.actionTodo,
    analysisStatus: item.analysisStatus,
    sprintStatus: item.sprintStatus,
    runningAgent: running?.agentName ?? null,
    openQuestion: chat.rows.some((message) => message.open),
    bugfix: fix,
  });
  return { waiting, entries };
}

export function registerTimelineRoutes(app: Router, pool: Pool): void {
  // Zeitleiste eines Auftrags: wer hat wann was gemacht, und worauf wartet er gerade.
  app.get('/development/:id/timeline', async (request, response, next) => {
    try {
      if (!isUuid(request.params.id)) return void response.status(404).json({ message: 'Auftrag nicht gefunden.' });
      const timeline = await loadTimeline(pool, request.params.id);
      if (!timeline) return void response.status(404).json({ message: 'Auftrag nicht gefunden.' });
      response.json(timeline);
    } catch (error) {
      next(error);
    }
  });
}
