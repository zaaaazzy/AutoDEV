// Gemeinsamer Zustand eines Auftragslaufs: Kontext, Budget-Prüfpunkt, geänderte Dateien und Verlauf je Schritt.
import type { Pool } from 'pg';
import type { KnownBug } from '../api/bugs.js';
import { logged } from '../core/log.js';
import { type CommandExecutor, redactOutput } from '../core/command.js';
import { AGENT_STEP_STATUS } from '../core/status.js';
import type { ProjectRouting } from '../agent/model-routing.js';
import { type BudgetState, checkBudget } from './budget.js';
import { changedFiles, type ChangedFile, type OrderBranch } from './git-sync.js';
import type { BuiltinAgent, StepSummary, WorkflowAgent, WorkItem, WorkItemOptions } from './runner-types.js';

export interface RunContext {
  pool: Pool;
  item: WorkItem;
  runId: string;
  options: WorkItemOptions;
  execute: CommandExecutor;
  builtin: BuiltinAgent;
  done: StepSummary[];
  bugs: KnownBug[];
  images: string[];
  fallbackCommand: string[] | null;
  projectContext: string;
  /** Eigener Git-Branch des Auftrags (null, wenn ohne Git oder kein Agent Dateien ändert). */
  branch?: OrderBranch | null;
  /** Akzeptanzkriterien aus dem Auftragstext und Definition of Done des Projekts. */
  criteria?: string[];
  definitionOfDone?: string[];
  sprintName?: string | null;
  /** Agents des Auftrags in Workflow-Reihenfolge (für Nachrichten an „den nächsten“ Agent). */
  ordered?: WorkflowAgent[];
  /** Nachrichten zwischen Agents (@@NACHRICHT), je Empfänger. */
  messages?: { toId: string; from: string; text: string }[];
  /** Ergebnis von „Vor dem Sprint“ für alle Aufträge des Sprints. */
  sprintNotes?: string | null;
  /** Höchster Budgetanteil (Prozent) aus der letzten Prüfung vor dem Schritt – für den Sparmodus im Routing. */
  budgetPercent?: number;
  /** Routing-Regeln und Stufen-Modelle des Projekts (einmal je Lauf geladen). */
  routing?: ProjectRouting | null;
  /** Kalibrierte Schätzung des Auftrags in Agent-Stunden fürs Routing (einmal je Lauf berechnet). */
  routedHours?: number | null;
  /** Zuletzt ermittelte geänderte Dateien des Auftrags (für den Abschnitt „Geänderte Dateien“). */
  changedFiles?: string[];
  /** Grund, warum der Lauf angehalten wurde (z. B. Budget), für die Push-Nachricht. */
  stopReason?: string | null;
}

/**
 * Budget-Prüfpunkt vor jedem Agent-Schritt (Tag, Sprint, Auftrag): liefert den erreichten Zeitraum oder null. Ein
 * bereits laufender Schritt wird nie abgebrochen; das Limit kann daher um höchstens einen Schritt überschritten werden.
 * Mit `role` (agents.role des Schritts) gelten zusätzlich die Limits dieser Agent-Rolle.
 */
export async function budgetGate(ctx: RunContext, role?: string | null): Promise<BudgetState | null> {
  const check = await checkBudget(ctx.pool, ctx.item.projectSlug, {
    itemId: ctx.item.id,
    sprintId: ctx.item.sprintId ?? null,
    role: role ?? null,
  });
  ctx.budgetPercent = check.percent;
  return check.exceeded;
}

/** Pause, bis ein Auftrag nach einer gescheiterten Budgetprüfung wieder startet (kein sofortiger Neustart). */
export const BUDGET_CHECK_RETRY_MS = 5 * 60_000;

/**
 * Budget-Prüfpunkt, der nie still durchlässt: Scheitert die Abfrage selbst (z. B. Datenbank kurz weg), gilt das Budget
 * nicht als „nicht erreicht“ – `failed` enthält dann die Begründung, und der Agent darf nicht starten.
 */
export async function guardedBudgetGate(
  ctx: RunContext,
  agent: Pick<WorkflowAgent, 'name' | 'role'>,
): Promise<{ stop: BudgetState | null; failed?: string }> {
  try {
    return { stop: await budgetGate(ctx, agent.role) };
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    console.error(`[${ctx.item.id}] Budgetprüfung gescheitert:`, error);
    return {
      stop: null,
      failed:
        `Unterbrochen: Das Budget liess sich nicht prüfen (${cause}) – „${agent.name}“ startet nicht ohne ` +
        `Budgetprüfung. Der Auftrag startet in ${BUDGET_CHECK_RETRY_MS / 60_000} Minuten wieder.`,
    };
  }
}

/**
 * Gescheiterte Budgetprüfung festhalten: Begründung am Auftrag (failure), Pause bis zum nächsten Start (retry_after)
 * und – ohne laufenden Schritt – ein eigener unterbrochener Schritt des Agents, damit der nächste Lauf bei ihm
 * fortsetzt. Eine Anweisung, also eine Transaktion. `position` null = der Schritt läuft schon (runStep markiert ihn).
 */
export async function recordBudgetCheckFailure(
  ctx: RunContext,
  agent: Pick<WorkflowAgent, 'id' | 'name' | 'phase' | 'stepId'>,
  reason: string,
  position: number | null,
): Promise<void> {
  await ctx.pool.query(
    `WITH step AS (
       INSERT INTO agent_run_steps (run_id, position, agent_id, agent_name, phase, status, workflow_step_id, output,
                                    interrupted)
       SELECT $3, $4::int, (SELECT id FROM agents WHERE id = $5::uuid), $6, $7, '${AGENT_STEP_STATUS.failed}',
              (SELECT id FROM workflow_steps WHERE id = $8::uuid), $2, TRUE
        WHERE $4::int IS NOT NULL
       RETURNING id)
     UPDATE development_items SET failure = $2, retry_after = NOW() + make_interval(secs => $9), updated_at = NOW()
      WHERE id = $1`,
    [
      ctx.item.id,
      reason,
      ctx.runId,
      position,
      agent.id,
      agent.name,
      agent.phase,
      agent.stepId ?? null,
      BUDGET_CHECK_RETRY_MS / 1000,
    ],
  );
}

/** Vom Auftrag geänderte Dateien (nur mit Auftrags-Branch; sonst undefined = unbekannt). */
export async function orderChangedFiles(ctx: RunContext): Promise<ChangedFile[] | undefined> {
  if (!ctx.branch) return undefined;
  return (
    (await changedFiles(ctx.options.cwd, ctx.branch.base, ctx.execute).catch(logged('runner-steps', null))) ?? undefined
  );
}

export async function orderFilePaths(ctx: RunContext): Promise<string[] | undefined> {
  return (await orderChangedFiles(ctx))?.map((file) => file.path);
}

/** Appends a timestamped entry to the step's history (shown as "Verlauf"). */
export function logEvent(pool: Pool, stepId: string | undefined, text: string): Promise<unknown> {
  return pool
    .query(`UPDATE agent_run_steps SET events = events || $2::jsonb WHERE id = $1`, [
      stepId,
      JSON.stringify([{ at: new Date().toISOString(), text: redactOutput(text, process.env) }]),
    ])
    .catch(logged('runner-steps'));
}
