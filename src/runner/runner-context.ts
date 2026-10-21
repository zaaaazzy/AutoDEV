// Gemeinsamer Zustand eines Auftragslaufs: Kontext, Budget-Prüfpunkt, geänderte Dateien und Verlauf je Schritt.
import type { Pool } from 'pg';
import type { KnownBug } from '../api/bugs.js';
import { logged } from '../core/log.js';
import { type CommandExecutor, redactOutput } from '../core/command.js';
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
  /** Zuletzt ermittelte geänderte Dateien des Auftrags (für den Abschnitt „Geänderte Dateien“). */
  changedFiles?: string[];
  /** Grund, warum der Lauf angehalten wurde (z. B. Budget), für die Push-Nachricht. */
  stopReason?: string | null;
}

/**
 * Budget-Prüfpunkt vor jedem Agent-Schritt (Tag, Sprint, Auftrag): liefert den erreichten Zeitraum oder null. Ein
 * bereits laufender Schritt wird nie abgebrochen; das Limit kann daher um höchstens einen Schritt überschritten werden.
 */
export async function budgetGate(ctx: RunContext): Promise<BudgetState | null> {
  const check = await checkBudget(ctx.pool, ctx.item.projectSlug, {
    itemId: ctx.item.id,
    sprintId: ctx.item.sprintId ?? null,
  });
  ctx.budgetPercent = check.percent;
  return check.exceeded;
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
