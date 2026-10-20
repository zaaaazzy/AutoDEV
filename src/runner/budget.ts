import type { Pool } from 'pg';
import { logged } from '../core/log.js';
import { sendPush } from '../core/push.js';
import { budgetActionTodo, setActionTodo } from './action-todo.js';

export const BUDGET_PERIODS = ['day', 'sprint', 'order'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export const PERIOD_LABELS: Record<BudgetPeriod, string> = {
  day: 'Tageslimit',
  sprint: 'Sprintlimit',
  order: 'Auftragslimit',
};

/** Ab diesem Anteil kommt einmal je Periode eine Push-Warnung, und das Routing schaltet in den Sparmodus. */
export const WARN_PERCENT = 80;

export interface BudgetLimit {
  period: BudgetPeriod;
  /** null = unbegrenzt */
  maxTokens: number | null;
  maxCostUsd: number | null;
}

export interface Spend {
  tokens: number;
  costUsd: number;
}

/** Stand eines Zeitraums: Periode (Tag, Sprint, Auftrag), Verbrauch und Anteil am Limit. */
export interface BudgetState {
  period: BudgetPeriod;
  /** Kennung der Periode (Datum, Sprint-ID, Auftrag): je Kennung wird höchstens einmal gewarnt. */
  key: string;
  limit: BudgetLimit;
  spend: Spend;
  /** Höchster Anteil von Tokens und Kosten am jeweiligen Limit, in Prozent. */
  percent: number;
}

/** Bereich eines Laufs: der Auftrag (für Auftrags- und Sprintlimit) oder nur das Projekt (Chat, Autor, Visionär). */
export interface BudgetScope {
  itemId?: string | null;
  sprintId?: string | null;
}

/** Leere oder ungültige Werte bedeuten unbegrenzt. */
const limitValue = (value: unknown): number | null =>
  value === null || value === undefined || value === '' || !(Number(value) > 0) ? null : Number(value);

export const hasLimit = (limit: BudgetLimit): boolean => limit.maxTokens !== null || limit.maxCostUsd !== null;

/** Budgets eines Projekts; Zeiträume ohne Grenze fehlen (= keine Prüfung, wie bisher). */
export async function loadBudgets(pool: Pool, project: string): Promise<BudgetLimit[]> {
  const rows = (
    await pool.query<{ period: BudgetPeriod; maxTokens: string | null; maxCostUsd: string | null }>(
      `SELECT period, max_tokens AS "maxTokens", max_cost_usd AS "maxCostUsd" FROM budgets WHERE project_slug = $1`,
      [project],
    )
  ).rows;
  return rows
    .map((row) => ({
      period: row.period,
      maxTokens: limitValue(row.maxTokens),
      maxCostUsd: limitValue(row.maxCostUsd),
    }))
    .filter(hasLimit);
}

/** Anteil am Limit in Prozent (der höhere von Tokens und Kosten); 0 ohne Limit. */
export function usagePercent(spend: Spend, limit: BudgetLimit): number {
  const shares = [
    limit.maxTokens === null ? 0 : spend.tokens / limit.maxTokens,
    limit.maxCostUsd === null ? 0 : spend.costUsd / limit.maxCostUsd,
  ];
  return Math.round(Math.max(...shares) * 1000) / 10;
}

const spendRow = (row: { tokens?: string | number | null; cost?: string | number | null } | undefined): Spend => ({
  tokens: Number(row?.tokens ?? 0),
  costUsd: Number(row?.cost ?? 0),
});

/** Verbrauch eines Projekts seit einem Zeitpunkt: Workflow-Schritte und Systemagents (agent_usage). */
async function spendSince(pool: Pool, project: string, since: string): Promise<Spend> {
  const row = (
    await pool.query<{ tokens: string; cost: string }>(
      `SELECT COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(cost), 0) AS cost FROM (
         SELECT s.tokens, s.cost_usd AS cost FROM agent_run_steps s JOIN agent_runs r ON r.id = s.run_id
          WHERE r.project_slug = $1 AND COALESCE(s.started_at, r.started_at) >= $2::timestamptz
         UNION ALL
         SELECT tokens, cost_usd FROM agent_usage WHERE project_slug = $1 AND created_at >= $2::timestamptz
       ) spent`,
      [project, since],
    )
  ).rows[0];
  return spendRow(row);
}

/** Verbrauch eines Auftrags über alle Läufe seit dem letzten manuellen Start („Erneut versuchen“). */
export async function loadOrderSpend(pool: Pool, itemId: string): Promise<Spend & { since: string | null }> {
  const row = (
    await pool.query<{ tokens: string | null; cost: string | null; since: string | null }>(
      `SELECT COALESCE(SUM(s.tokens), 0) AS tokens, COALESCE(SUM(s.cost_usd), 0) AS cost,
              (SELECT budget_since::text FROM development_items WHERE id = $1) AS since
         FROM agent_run_steps s
         JOIN agent_runs r ON r.id = s.run_id
         JOIN development_items d ON d.id = r.development_id
        WHERE r.development_id = $1 AND (d.budget_since IS NULL OR r.started_at >= d.budget_since)`,
      [itemId],
    )
  ).rows[0];
  return { ...spendRow(row), since: row?.since ?? null };
}

/** Periode und Verbrauch eines Zeitraums; null, wenn er für diesen Lauf nicht gilt (kein Sprint, kein Auftrag). */
async function periodSpend(
  pool: Pool,
  project: string,
  period: BudgetPeriod,
  scope: BudgetScope,
): Promise<{ key: string; spend: Spend } | null> {
  if (period === 'day') {
    const day = (
      await pool.query<{ key: string; since: string }>(
        `SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS key, date_trunc('day', NOW())::text AS since`,
      )
    ).rows[0];
    return day ? { key: day.key, spend: await spendSince(pool, project, day.since) } : null;
  }
  if (period === 'sprint') {
    // Sprint des Auftrags, sonst der aktive Sprint des Projekts.
    const sprint = (
      await pool.query<{ id: string; since: string }>(
        `SELECT id, COALESCE(start_date::timestamptz, created_at)::text AS since FROM sprints
          WHERE project_slug = $1 AND (id = $2::uuid OR ($2::uuid IS NULL AND status = 'active'))
          ORDER BY status = 'active' DESC LIMIT 1`,
        [project, scope.sprintId ?? null],
      )
    ).rows[0];
    return sprint ? { key: sprint.id, spend: await spendSince(pool, project, sprint.since) } : null;
  }
  if (!scope.itemId) return null;
  const order = await loadOrderSpend(pool, scope.itemId);
  return { key: `${scope.itemId}:${order.since ?? ''}`, spend: order };
}

/** Stand aller begrenzten Zeiträume, die für den Lauf gelten. */
export async function budgetStates(
  pool: Pool,
  project: string,
  scope: BudgetScope = {},
  limits?: BudgetLimit[],
): Promise<BudgetState[]> {
  const states: BudgetState[] = [];
  for (const limit of limits ?? (await loadBudgets(pool, project))) {
    const current = await periodSpend(pool, project, limit.period, scope);
    if (current) states.push({ ...current, period: limit.period, limit, percent: usagePercent(current.spend, limit) });
  }
  return states;
}

const formatTokens = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)} Mio. Tokens`
    : tokens >= 1000
      ? `${Math.round(tokens / 1000)}k Tokens`
      : `${tokens} Tokens`;

/** „Tageslimit: 1.2 Mio. Tokens von 1.0 Mio. Tokens“ – der Wert, der das Limit am stärksten ausschöpft. */
export function describeState(state: BudgetState): string {
  const { spend, limit } = state;
  const tokenShare = limit.maxTokens === null ? -1 : spend.tokens / limit.maxTokens;
  const costShare = limit.maxCostUsd === null ? -1 : spend.costUsd / limit.maxCostUsd;
  const detail =
    tokenShare >= costShare
      ? `${formatTokens(spend.tokens)} von ${formatTokens(limit.maxTokens ?? 0)}`
      : `${spend.costUsd.toFixed(2)} USD von ${(limit.maxCostUsd ?? 0).toFixed(2)} USD`;
  return `${PERIOD_LABELS[state.period]}: ${detail}`;
}

/** Erster erreichter Zeitraum (≥ 100 %) – sonst null. */
export function exceededState(states: BudgetState[]): BudgetState | null {
  return states.find((state) => state.percent >= 100) ?? null;
}

/** Text für „Aktion notwendig“ beim Auftrag. */
export function budgetTodo(state: BudgetState): string {
  return budgetActionTodo(state.period === 'day', describeState(state));
}

/**
 * Push-Warnung ab 80 %: genau eine je Projekt, Zeitraum und Periode. Die gemeldete Schwelle steht in
 * budget_warnings; nur wer die Zeile anlegt, sendet (auch bei gleichzeitigen Prüfungen).
 */
export async function warnThresholds(
  pool: Pool,
  project: string,
  states: BudgetState[],
  send: typeof sendPush = sendPush,
): Promise<BudgetState[]> {
  const warned: BudgetState[] = [];
  for (const state of states.filter((entry) => entry.percent >= WARN_PERCENT)) {
    const inserted = await pool.query(
      `INSERT INTO budget_warnings (project_slug, period, period_key, threshold) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING RETURNING 1`,
      [project, state.period, state.key, WARN_PERCENT],
    );
    if (!inserted.rows.length) continue;
    warned.push(state);
    await send(
      pool,
      {
        title: `💰 Budget zu ${Math.min(Math.round(state.percent), 999)} % verbraucht · ${project}`,
        body: `${describeState(state)}. Ab 100 % starten keine neuen Agent-Schritte mehr.`,
        url: '#settings',
        tag: `budget-${project}-${state.period}`,
      },
      { project },
    ).catch(logged('budget', 0));
  }
  return warned;
}

export interface BudgetCheck {
  states: BudgetState[];
  /** Erreichter Zeitraum: kein neuer Lauf bzw. Schritt. */
  exceeded: BudgetState | null;
  /** Höchster Anteil aller Zeiträume (für den Sparmodus im Routing). */
  percent: number;
}

/**
 * Prüfpunkt vor jedem Lauf und Schritt: Stand aller Limits, Warnung ab 80 %. Ohne Limits keine Abfrage des
 * Verbrauchs (Verhalten wie ohne Budget).
 */
export async function checkBudget(pool: Pool, project: string, scope: BudgetScope = {}): Promise<BudgetCheck> {
  const limits = await loadBudgets(pool, project);
  if (!limits.length) return { states: [], exceeded: null, percent: 0 };
  const states = await budgetStates(pool, project, scope, limits);
  await warnThresholds(pool, project, states).catch(logged('budget', []));
  return {
    states,
    exceeded: exceededState(states),
    percent: states.reduce((max, state) => Math.max(max, state.percent), 0),
  };
}

/** Projektweit erreicht (Tag oder Sprint)? Dann startet der Worker keine neuen Aufträge. */
export async function projectBudgetExceeded(pool: Pool, project: string): Promise<BudgetState | null> {
  const limits = (await loadBudgets(pool, project)).filter((limit) => limit.period !== 'order');
  if (!limits.length) return null;
  return exceededState(await budgetStates(pool, project, {}, limits));
}

/** Blockiert einen Auftrag wegen Budget: „Aktion notwendig“ mit Hinweis; der Zeitraum gibt ihn später wieder frei. */
export async function blockForBudget(pool: Pool, itemId: string, state: BudgetState): Promise<string> {
  const todo = budgetTodo(state);
  await pool.query(`UPDATE development_items SET failure = $2, budget_blocked = $3 WHERE id = $1`, [
    itemId,
    todo,
    state.period,
  ]);
  return todo;
}

/**
 * Projektbudget (Tag/Sprint) erreicht, bevor ein Auftrag startet: Der nächste Auftrag wartet sichtbar mit
 * „Aktion notwendig“ (und einer Push-Nachricht). Wartet schon einer, bleiben die übrigen einfach eingeplant.
 */
export async function holdForBudget(
  pool: Pool,
  item: { id: string; projectSlug: string; title: string },
  state: BudgetState,
  send: typeof sendPush = sendPush,
): Promise<boolean> {
  const todo = budgetTodo(state);
  const held = await pool.query(
    `UPDATE development_items d SET status = 'blocked', failure = $2, budget_blocked = $3, updated_at = NOW()
      WHERE d.id = $1 AND NOT EXISTS (
        SELECT 1 FROM development_items o WHERE o.project_slug = d.project_slug AND o.status = 'blocked'
           AND o.budget_blocked IN ('day', 'sprint'))
      RETURNING d.id`,
    [item.id, todo, state.period],
  );
  if (!held.rows.length) return false;
  console.info(`[${item.id}] ${todo}`);
  await setActionTodo(pool, item.id, todo).catch(logged('budget'));
  await send(
    pool,
    {
      title: `⚠ Budget erreicht · ${item.projectSlug}`,
      body: `${item.title}\n${todo}`,
      url: '#development',
      tag: `order-${item.id}`,
    },
    { project: item.projectSlug },
  ).catch(logged('budget', 0));
  return true;
}

/**
 * Gibt wegen Budget blockierte Aufträge frei, sobald ihr Zeitraum wieder Luft hat (Tageslimit am Folgetag, nach
 * Erhöhen oder Entfernen des Limits). Die Aktion „Budget“ verschwindet dabei.
 */
export async function releaseBudgetBlocks(pool: Pool, project: string): Promise<string[]> {
  const blocked = (
    await pool.query<{ id: string; sprintId: string | null; period: BudgetPeriod }>(
      `SELECT id, sprint_id AS "sprintId", budget_blocked AS period FROM development_items
        WHERE project_slug = $1 AND status = 'blocked' AND budget_blocked IS NOT NULL`,
      [project],
    )
  ).rows;
  if (!blocked.length) return [];
  const limits = await loadBudgets(pool, project);
  const released: string[] = [];
  for (const item of blocked) {
    const states = await budgetStates(pool, project, { itemId: item.id, sprintId: item.sprintId }, limits);
    if (exceededState(states)) continue;
    const result = await pool.query(
      `UPDATE development_items SET status = 'planned', auto_run = TRUE, failure = NULL, budget_blocked = NULL,
              updated_at = NOW()
        WHERE id = $1 AND status = 'blocked' AND budget_blocked IS NOT NULL`,
      [item.id],
    );
    if (!result.rowCount) continue;
    await setActionTodo(pool, item.id, null).catch(logged('budget'));
    released.push(item.id);
  }
  return released;
}
