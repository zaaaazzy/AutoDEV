// Überschreitungs-Stopp: Nach jedem Agent-Schritt wird der gemessene Verbrauch mit dem Dreifachen der kalibrierten
// Schätzung verglichen. Liegt Laufzeit oder Tokens darüber, startet kein weiterer Schritt: Der Auftrag wartet als
// „Aktion notwendig“, bis ein Mensch ihn mit „Erneut versuchen“ freigibt. Die Budget-Prüfung läuft davon unabhängig.
import type { Pool } from 'pg';
import {
  calibratedHours,
  calibratedTokens,
  type Effort,
  estimateOverrun,
  OVERRUN_FACTOR,
} from '../core/estimate-calibration.js';
import { overrunActionTodo } from './action-todo.js';
import { BUDGET_CHECK_RETRY_MS, orderCalibration, type RunContext } from './runner-context.js';
import type { WorkflowAgent, WorkItem } from './runner-types.js';

export interface OverrunState {
  /** Gemessener Verbrauch seit der letzten Freigabe (Agent-Stunden und Tokens aller Schritte). */
  actual: { hours: number; tokens: number };
  /** Kalibrierte Schätzung (null = für diesen Wert keine Schätzung). */
  estimate: Effort;
  exceeded: { hours: boolean; tokens: boolean };
}

const positive = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

/** Gespeicherte (nicht kalibrierte) Schätzung des Auftrags; null, wenn weder Stunden noch Tokens geschätzt sind. */
export function rawEstimate(item: Pick<WorkItem, 'effortHours' | 'tokenEstimate'>): Effort | null {
  const estimate = { hours: positive(item.effortHours), tokens: positive(item.tokenEstimate) };
  return estimate.hours === null && estimate.tokens === null ? null : estimate;
}

/**
 * Ist-Verbrauch eines Auftrags seit dem letzten manuellen Start bzw. der Freigabe (`budget_since`): Laufzeit und Tokens
 * aller Agent-Schritte, jeder Rolle (auch des Testers mit eigenem CLI). Nach einer Freigabe beginnt die Messung neu, die
 * Schwelle gilt dann für die (ggf. neue) Schätzung – sonst blockierte der Auftrag sofort wieder.
 */
export async function loadOrderEffort(pool: Pool, itemId: string): Promise<{ hours: number; tokens: number }> {
  const row = (
    await pool.query<{ ms: string | number | null; tokens: string | number | null }>(
      `SELECT COALESCE(SUM(s.duration_ms), 0) AS ms, COALESCE(SUM(s.tokens), 0) AS tokens
         FROM agent_run_steps s
         JOIN agent_runs r ON r.id = s.run_id
         JOIN development_items d ON d.id = r.development_id
        WHERE r.development_id = $1 AND (d.budget_since IS NULL OR r.started_at >= d.budget_since)`,
      [itemId],
    )
  ).rows[0];
  return { hours: Number(row?.ms ?? 0) / 3_600_000, tokens: Number(row?.tokens ?? 0) };
}

/**
 * Prüfpunkt vor dem nächsten Schritt: Überschreitet der Ist-Wert das Dreifache der kalibrierten Schätzung (Stunden
 * oder Tokens)? Aufträge ohne Schätzung prüft er nicht (keine Abfrage). Fehler gehen an den Aufrufer.
 */
export async function overrunGate(ctx: RunContext): Promise<OverrunState | null> {
  const raw = rawEstimate(ctx.item);
  if (!raw) return null;
  const calibration = await orderCalibration(ctx);
  const estimate = {
    hours: calibratedHours(raw.hours, ctx.item.estimateSource, calibration),
    tokens: calibratedTokens(raw.tokens, ctx.item.estimateSource, calibration),
  };
  const actual = await loadOrderEffort(ctx.pool, ctx.item.id);
  const exceeded = estimateOverrun(actual, estimate);
  return exceeded ? { actual, estimate, exceeded } : null;
}

/**
 * Prüfpunkt, der nie still durchlässt (wie `guardedBudgetGate`): Scheitert die Prüfung selbst, startet der Agent
 * nicht – `failed` enthält die Begründung, der Auftrag gilt als unterbrochen und startet nach einer Pause wieder.
 */
export async function guardedOverrunGate(
  ctx: RunContext,
  agent: Pick<WorkflowAgent, 'name'>,
): Promise<{ stop: OverrunState | null; failed?: string }> {
  try {
    return { stop: await overrunGate(ctx) };
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    console.error(`[${ctx.item.id}] Prüfung der Schätzung gescheitert:`, error);
    return {
      stop: null,
      failed:
        `Unterbrochen: Der Verbrauch liess sich nicht mit der Schätzung vergleichen (${cause}) – „${agent.name}“ ` +
        `startet nicht ohne Prüfung. Der Auftrag startet in ${BUDGET_CHECK_RETRY_MS / 60_000} Minuten wieder.`,
    };
  }
}

const formatHours = (hours: number): string =>
  `${hours.toLocaleString('de-DE', { maximumFractionDigits: hours < 1 ? 2 : 1 })} h`;

const formatTokens = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Mio. Tokens`
    : tokens >= 1000
      ? `${Math.round(tokens / 1000)}k Tokens`
      : `${Math.round(tokens)} Tokens`;

/** Ist- und Schätzwert lesbar, nur die geschätzten Werte („1,6 h / 9,2 Mio. Tokens“). */
export function describeOverrun(state: OverrunState): { actual: string; estimate: string } {
  const actual: string[] = [];
  const estimate: string[] = [];
  if (state.estimate.hours !== null) {
    actual.push(formatHours(state.actual.hours));
    estimate.push(formatHours(state.estimate.hours));
  }
  if (state.estimate.tokens !== null) {
    actual.push(formatTokens(state.actual.tokens));
    estimate.push(formatTokens(state.estimate.tokens));
  }
  return { actual: actual.join(' / '), estimate: estimate.join(' / ') };
}

/** Text für „Aktion notwendig“ beim Auftrag. */
export function overrunTodo(state: OverrunState): string {
  const { actual, estimate } = describeOverrun(state);
  return overrunActionTodo(actual, estimate);
}

/**
 * Blockiert einen Auftrag wegen überschrittener Schätzung: Der Grund mit Ist- und Schätzwert steht am Auftrag
 * (`failure`) – auch ohne fehlgeschlagenen Schritt. Gibt den Text für „Aktion notwendig“ zurück.
 */
export async function blockForOverrun(pool: Pool, itemId: string, state: OverrunState): Promise<string> {
  const { actual, estimate } = describeOverrun(state);
  const todo = overrunTodo(state);
  const failure =
    `Aktion notwendig: Schätzung überschritten – Ist ${actual}, kalibrierte Schätzung ${estimate} ` +
    `(Grenze: das ${OVERRUN_FACTOR}-Fache). Es startet kein weiterer Schritt; „Erneut versuchen“ gibt den Auftrag ` +
    'frei, danach zählt der Verbrauch neu gegen die aktuelle Schätzung.';
  await pool.query(`UPDATE development_items SET failure = $2 WHERE id = $1`, [itemId, failure]);
  return todo;
}
