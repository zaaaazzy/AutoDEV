// Lauf eines Auftrags belegen (ein Lauf je Auftrag, verwaiste Läufe abräumen) und die Agents des Laufs wählen.
import type { Pool } from 'pg';
import { ORDER_PHASES } from '../core/workflow-phases.js';
import { AGENT_RUN_STATUS } from '../core/status.js';
import { PHASE_ORDER } from './runner-prompts.js';
import { MAX_TIMEOUT_MINUTES } from './runner-selection.js';
import type { WorkflowAgent, WorkItem } from './runner-types.js';
import { VISUAL_CATEGORIES } from './visual-check.js';

/** Pause vor dem Wiederholen nach einem vorübergehenden Fehler. */
export const TRANSIENT_RETRY_DELAY_MS = 30_000;

/** Längste Laufzeit eines Schritts: höchstes Zeitlimit, nach einem vorübergehenden Fehler ein zweites Mal samt Pause. */
export const MAX_STEP_MS = 2 * MAX_TIMEOUT_MINUTES * 60_000 + TRANSIENT_RETRY_DELAY_MS;

/**
 * So lange ohne Lebenszeichen (Start des Laufs, Eintrag im Verlauf eines Schritts) gilt ein Lauf als verwaist. Liegt
 * über der längsten Schrittlaufzeit, mit Reserve für den Abschluss (Test-Gate, Merge), damit ein zweiter Worker nie
 * einen lebenden Lauf als gescheitert markiert.
 */
export const ABANDONED_RUN_MS = MAX_STEP_MS + 60 * 60_000;

/**
 * Claim an order run; a running run without any sign of life for ABANDONED_RUN_MS is treated as abandoned. Sein noch
 * laufender Schritt (Absturz des Workers) gilt als unterbrochen: Der nächste Lauf setzt beim selben Agent fort.
 */
export async function claimRun(pool: Pool, item: WorkItem): Promise<string | null> {
  await pool.query(
    `WITH abandoned AS (
       UPDATE agent_runs r SET status = '${AGENT_RUN_STATUS.failed}', completed_at = NOW()
        WHERE r.development_id = $1 AND r.status = '${AGENT_RUN_STATUS.running}'
          AND GREATEST(
                r.started_at,
                (SELECT MAX((event->>'at')::timestamptz)
                   FROM agent_run_steps s CROSS JOIN LATERAL jsonb_array_elements(s.events) event
                  WHERE s.run_id = r.id)
              ) < NOW() - $2 * INTERVAL '1 millisecond'
       RETURNING r.id)
     UPDATE agent_run_steps SET status = 'failed', interrupted = TRUE,
            output = COALESCE(output, '') || E'\\nUnterbrochen: Der Lauf hatte kein Lebenszeichen mehr (Absturz).'
      WHERE status = 'running' AND run_id IN (SELECT id FROM abandoned)`,
    [item.id, ABANDONED_RUN_MS],
  );
  const claim = await pool.query<{ id: string }>(
    `INSERT INTO agent_runs (project_slug, development_id, status)
     VALUES ($1, $2, '${AGENT_RUN_STATUS.running}')
     ON CONFLICT (development_id) WHERE status = 'running' DO NOTHING
     RETURNING id`,
    [item.projectSlug, item.id],
  );
  return claim.rows[0]?.id ?? null;
}

/**
 * Select agents in phase and position order, or only the assigned agent for a manual run. Die visuelle Prüfung
 * entfällt bei Aufträgen, die weder Frontend noch Fullstack sind.
 */
export function selectWorkflowAgents(agents: WorkflowAgent[], item: WorkItem): WorkflowAgent[] {
  return agents
    .filter((agent) => (ORDER_PHASES as readonly string[]).includes(agent.phase))
    .filter((agent) =>
      item.agentId
        ? agent.id === item.agentId
        : !(agent.role === 'author' && item.ideationId) &&
          !(agent.role === 'bug_reviewer' && item.risks?.trim()) &&
          !(agent.role === 'visual_tester' && !VISUAL_CATEGORIES.has(item.category ?? '')),
    )
    .sort(
      (left, right) =>
        PHASE_ORDER.indexOf(left.phase as never) - PHASE_ORDER.indexOf(right.phase as never) ||
        left.position - right.position,
    );
}
