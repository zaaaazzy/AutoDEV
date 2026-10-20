import type { Pool } from 'pg';

export interface OrderLimits {
  tokens: number | null;
  costUsd: number | null;
}

export interface OrderSpend {
  tokens: number;
  costUsd: number;
}

/** Grenzen je Auftrag aus den Projekteinstellungen (leer = keine Grenze). */
export async function loadOrderLimits(pool: Pool, project: string): Promise<OrderLimits> {
  const row = (
    await pool.query<{ tokens: string | number | null; cost: string | number | null }>(
      `SELECT order_token_limit AS tokens, order_cost_limit AS cost FROM projects WHERE slug = $1`,
      [project],
    )
  ).rows[0];
  const number = (value: string | number | null | undefined): number | null =>
    value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
  return { tokens: number(row?.tokens), costUsd: number(row?.cost) };
}

/** Verbrauch eines Auftrags über alle Läufe seit dem letzten manuellen Start („Erneut versuchen“). */
export async function loadOrderSpend(pool: Pool, itemId: string): Promise<OrderSpend> {
  const row = (
    await pool.query<{ tokens: string | number | null; cost: string | number | null }>(
      `SELECT COALESCE(SUM(s.tokens), 0) AS tokens, COALESCE(SUM(s.cost_usd), 0) AS cost
         FROM agent_run_steps s
         JOIN agent_runs r ON r.id = s.run_id
         JOIN development_items d ON d.id = r.development_id
        WHERE r.development_id = $1 AND (d.budget_since IS NULL OR r.started_at >= d.budget_since)`,
      [itemId],
    )
  ).rows[0];
  return { tokens: Number(row?.tokens ?? 0), costUsd: Number(row?.cost ?? 0) };
}

const formatTokens = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)} Mio. Tokens`
    : tokens >= 1000
      ? `${Math.round(tokens / 1000)}k Tokens`
      : `${tokens} Tokens`;

/** Meldung, wenn eine Grenze erreicht ist – sonst null. */
export function budgetExceeded(spend: OrderSpend, limits: OrderLimits): string | null {
  if (limits.tokens !== null && spend.tokens >= limits.tokens)
    return `Kostengrenze erreicht: ${formatTokens(spend.tokens)} von ${formatTokens(limits.tokens)}`;
  if (limits.costUsd !== null && spend.costUsd >= limits.costUsd)
    return `Kostengrenze erreicht: ${spend.costUsd.toFixed(2)} USD von ${limits.costUsd.toFixed(2)} USD`;
  return null;
}

export const BUDGET_TODO_SUFFIX = '– prüfen, dann „Erneut versuchen“ (neues Budget) oder Grenze erhöhen';
