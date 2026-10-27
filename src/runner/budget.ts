import type { Pool } from 'pg';
import { logged } from '../core/log.js';
import { sendPush } from '../core/push.js';
import { localDay, localTimeZone } from '../core/time-zone.js';
import { budgetActionTodo, setActionTodo } from './action-todo.js';

export const BUDGET_PERIODS = ['day', 'sprint', 'order'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export const PERIOD_LABELS: Record<BudgetPeriod, string> = {
  day: 'Tageslimit',
  sprint: 'Sprintlimit',
  order: 'Auftragslimit',
};

/** Agent-Rollen mit eigenem Token-Limit (agents.role ohne „custom“: dort gibt es keine feste Zuordnung). */
export const BUDGET_ROLES = [
  'author',
  'developer',
  'tester',
  'reviewer',
  'documenter',
  'bug_reviewer',
  'manual_writer',
  'user_manual_writer',
] as const;
export type BudgetRole = (typeof BUDGET_ROLES)[number];

export const isBudgetRole = (value: unknown): value is BudgetRole =>
  typeof value === 'string' && (BUDGET_ROLES as readonly string[]).includes(value);

/** Ab diesem Anteil kommt einmal je Periode eine Push-Warnung, und das Routing schaltet in den Sparmodus. */
export const WARN_PERCENT = 80;

export interface BudgetLimit {
  period: BudgetPeriod;
  /** null = unbegrenzt */
  maxTokens: number | null;
  maxCostUsd: number | null;
  /** Gesetzt = Limit einer Agent-Rolle (budget_role_limits), sonst Projektlimit (budgets). */
  role?: BudgetRole;
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
  /** Gesetzt = Stand eines Rollen-Limits; key trägt dann das Präfix „rolle:<role>:“. */
  role?: BudgetRole;
}

/** Bereich eines Laufs: der Auftrag (für Auftrags- und Sprintlimit) oder nur das Projekt (Chat, Autor, Visionär). */
export interface BudgetScope {
  itemId?: string | null;
  sprintId?: string | null;
  /** Agent-Rolle des anstehenden Schritts: prüft zusätzlich deren Limits. Ohne Rolle nur die Projektlimits. */
  role?: string | null;
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

/** Token-Limits je Agent-Rolle (optional nur einer Rolle); fehlende Zeile = keine Grenze für die Rolle. */
export async function loadRoleLimits(pool: Pool, project: string, role?: string | null): Promise<BudgetLimit[]> {
  const rows = (
    await pool.query<{ role: string; period: BudgetPeriod; maxTokens: string | null }>(
      `SELECT role, period, max_tokens AS "maxTokens" FROM budget_role_limits
        WHERE project_slug = $1 AND ($2::text IS NULL OR role = $2) ORDER BY role, period`,
      [project, role ?? null],
    )
  ).rows;
  return rows.flatMap((row) => {
    const maxTokens = limitValue(row.maxTokens);
    return isBudgetRole(row.role) && maxTokens !== null
      ? [{ period: row.period, maxTokens, maxCostUsd: null, role: row.role }]
      : [];
  });
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

/**
 * Verbrauch je Agent-Rolle seit einem Zeitpunkt: Workflow-Schritte über agent_id → agents.role und agent_usage.role.
 * Schritte ohne agent_id (eingebaute Agents, gelöschter Agent) zählen zu keiner Rolle, nur zum Projekt.
 */
export async function spendByRole(
  pool: Pool,
  project: string,
  since: string,
  roles: readonly string[] = BUDGET_ROLES,
): Promise<Map<string, Spend>> {
  const rows = (
    await pool.query<{ role: string; tokens: string; cost: string }>(
      `SELECT role, COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(cost), 0) AS cost FROM (
         SELECT a.role, s.tokens, s.cost_usd AS cost FROM agent_run_steps s
           JOIN agent_runs r ON r.id = s.run_id JOIN agents a ON a.id = s.agent_id
          WHERE r.project_slug = $1 AND COALESCE(s.started_at, r.started_at) >= $2::timestamptz AND a.role = ANY($3)
         UNION ALL
         SELECT role, tokens, cost_usd FROM agent_usage
          WHERE project_slug = $1 AND created_at >= $2::timestamptz AND role = ANY($3)
       ) spent GROUP BY role`,
      [project, since, [...roles]],
    )
  ).rows;
  return new Map(rows.map((row) => [row.role, spendRow(row)]));
}

/**
 * Verbrauch eines Sprints: nur Workflow-Läufe der Aufträge dieses Sprints seit Sprintbeginn. Chat, Autor und Visionär
 * (agent_usage, ohne Auftrag) und Aufträge ausserhalb des Sprints zählen nicht. Ein Ende braucht es nicht: Das
 * Sprintlimit gilt nur, solange der Sprint aktiv ist (sprintStart).
 */
export async function sprintSpendByRole(
  pool: Pool,
  project: string,
  sprint: { id: string; since: string },
  roles: readonly string[] = BUDGET_ROLES,
): Promise<Map<string, Spend>> {
  const rows = (
    await pool.query<{ role: string; tokens: string; cost: string }>(
      `SELECT a.role, COALESCE(SUM(s.tokens), 0) AS tokens, COALESCE(SUM(s.cost_usd), 0) AS cost
         FROM agent_run_steps s JOIN agent_runs r ON r.id = s.run_id
         JOIN development_items d ON d.id = r.development_id JOIN agents a ON a.id = s.agent_id
        WHERE r.project_slug = $1 AND d.sprint_id = $2::uuid AND COALESCE(s.started_at, r.started_at) >= $3::timestamptz
          AND a.role = ANY($4)
        GROUP BY a.role`,
      [project, sprint.id, sprint.since, [...roles]],
    )
  ).rows;
  return new Map(rows.map((row) => [row.role, spendRow(row)]));
}

/** Gesamtverbrauch eines Sprints (alle Schritte seiner Aufträge, auch ohne agent_id); siehe sprintSpendByRole. */
async function sprintSpend(pool: Pool, project: string, sprint: { id: string; since: string }): Promise<Spend> {
  const row = (
    await pool.query<{ tokens: string; cost: string }>(
      `SELECT COALESCE(SUM(s.tokens), 0) AS tokens, COALESCE(SUM(s.cost_usd), 0) AS cost
         FROM agent_run_steps s JOIN agent_runs r ON r.id = s.run_id
         JOIN development_items d ON d.id = r.development_id
        WHERE r.project_slug = $1 AND d.sprint_id = $2::uuid AND COALESCE(s.started_at, r.started_at) >= $3::timestamptz`,
      [project, sprint.id, sprint.since],
    )
  ).rows[0];
  return spendRow(row);
}

/** Verbrauch einer Rolle in einem Auftrag seit dem letzten manuellen Start (nur Schritte mit agent_id). */
async function loadRoleOrderSpend(pool: Pool, itemId: string, role: string): Promise<Spend & { since: string | null }> {
  const row = (
    await pool.query<{ tokens: string | null; cost: string | null; since: string | null }>(
      `SELECT COALESCE(SUM(s.tokens), 0) AS tokens, COALESCE(SUM(s.cost_usd), 0) AS cost,
              (SELECT budget_since::text FROM development_items WHERE id = $1) AS since
         FROM agent_run_steps s
         JOIN agent_runs r ON r.id = s.run_id
         JOIN development_items d ON d.id = r.development_id
         JOIN agents a ON a.id = s.agent_id
        WHERE r.development_id = $1 AND a.role = $2 AND (d.budget_since IS NULL OR r.started_at >= d.budget_since)`,
      [itemId, role],
    )
  ).rows[0];
  return { ...spendRow(row), since: row?.since ?? null };
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

/**
 * Beginn des Sprints (des Auftrags, sonst des aktiven Sprints); null ohne Sprint. Nur ein aktiver Sprint hat ein
 * Sprintlimit: Ist der Sprint des Auftrags geplant, im Review, abgeschlossen oder abgebrochen, gilt keins.
 */
export async function sprintStart(
  pool: Pool,
  project: string,
  sprintId: string | null | undefined,
): Promise<{ id: string; since: string } | null> {
  return (
    (
      await pool.query<{ id: string; since: string }>(
        `SELECT id, COALESCE(start_date::timestamp AT TIME ZONE $3::text, created_at)::text AS since FROM sprints
          WHERE project_slug = $1 AND status = 'active' AND ($2::uuid IS NULL OR id = $2::uuid)
          ORDER BY created_at LIMIT 1`,
        [project, sprintId ?? null, localTimeZone()],
      )
    ).rows[0] ?? null
  );
}

/** Kennung der Periode eines Rollen-Limits in budget_warnings (Tabelle bleibt unverändert). */
export const roleKey = (role: string, key: string): string => `rolle:${role}:${key}`;

/**
 * Periode und Verbrauch eines Zeitraums; null, wenn er für diesen Lauf nicht gilt (kein Sprint, kein Auftrag).
 * Mit Rolle: nur der Verbrauch dieser Agent-Rolle.
 */
async function periodSpend(
  pool: Pool,
  project: string,
  period: BudgetPeriod,
  scope: BudgetScope,
  role?: BudgetRole,
): Promise<{ key: string; spend: Spend } | null> {
  const since = async (from: string): Promise<Spend> =>
    role
      ? ((await spendByRole(pool, project, from, [role])).get(role) ?? { tokens: 0, costUsd: 0 })
      : spendSince(pool, project, from);
  const keyed = (key: string) => (role ? roleKey(role, key) : key);
  if (period === 'day') {
    // Budget-Tag in Ortszeit (DEV_LOG_TIMEZONE): beginnt um Mitternacht vor Ort, nicht um Mitternacht UTC.
    const day = localDay();
    return { key: keyed(day.key), spend: await since(day.since) };
  }
  if (period === 'sprint') {
    // Sprint des Auftrags, sonst der aktive Sprint des Projekts; es zählen nur die Läufe seiner Aufträge.
    const sprint = await sprintStart(pool, project, scope.sprintId);
    if (!sprint) return null;
    const spend = role
      ? ((await sprintSpendByRole(pool, project, sprint, [role])).get(role) ?? { tokens: 0, costUsd: 0 })
      : await sprintSpend(pool, project, sprint);
    return { key: keyed(sprint.id), spend };
  }
  if (!scope.itemId) return null;
  const order = role ? await loadRoleOrderSpend(pool, scope.itemId, role) : await loadOrderSpend(pool, scope.itemId);
  return { key: keyed(`${scope.itemId}:${order.since ?? ''}`), spend: order };
}

/** Stand aller begrenzten Zeiträume, die für den Lauf gelten (Projekt- und übergebene Rollen-Limits). */
export async function budgetStates(
  pool: Pool,
  project: string,
  scope: BudgetScope = {},
  limits?: BudgetLimit[],
): Promise<BudgetState[]> {
  const states: BudgetState[] = [];
  for (const limit of limits ?? (await loadBudgets(pool, project))) {
    const current = await periodSpend(pool, project, limit.period, scope, limit.role);
    if (!current) continue;
    const state: BudgetState = { ...current, period: limit.period, limit, percent: usagePercent(current.spend, limit) };
    if (limit.role) state.role = limit.role;
    states.push(state);
  }
  return states;
}

/** Projektlimits und – mit Rolle im Bereich – die Limits dieser Rolle. */
async function scopeLimits(pool: Pool, project: string, role: string | null | undefined): Promise<BudgetLimit[]> {
  const limits = await loadBudgets(pool, project);
  return isBudgetRole(role) ? [...limits, ...(await loadRoleLimits(pool, project, role))] : limits;
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
  const label = state.role ? `${PERIOD_LABELS[state.period]} der Rolle „${state.role}“` : PERIOD_LABELS[state.period];
  return `${label}: ${detail}`;
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
        title: `💰 Budget${state.role ? ` (${state.role})` : ''} zu ${Math.min(Math.round(state.percent), 999)} % verbraucht · ${project}`,
        body: `${describeState(state)}. Ab 100 % starten keine neuen ${state.role ? 'Schritte dieser Rolle' : 'Agent-Schritte'} mehr.`,
        url: `#settings?project=${encodeURIComponent(project)}`,
        tag: `budget-${project}-${state.period}${state.role ? `-${state.role}` : ''}`,
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
 * Prüfpunkt vor jedem Lauf und Schritt: Stand aller Limits (Projekt, mit scope.role auch die der Rolle), Warnung ab
 * 80 %. Ohne Limits keine Abfrage des Verbrauchs (Verhalten wie ohne Budget).
 */
export async function checkBudget(pool: Pool, project: string, scope: BudgetScope = {}): Promise<BudgetCheck> {
  const limits = await scopeLimits(pool, project, scope.role);
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
  // Der Grund (Rolle, Zeitraum, Grenzwert, Verbrauch) steht am Auftrag – auch ohne fehlgeschlagenen Schritt.
  await pool.query(
    `UPDATE development_items SET failure = $2, budget_blocked = $3, budget_blocked_role = $4 WHERE id = $1`,
    [itemId, todo, state.period, state.role ?? null],
  );
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
    `UPDATE development_items d SET status = 'blocked', failure = $2, budget_blocked = $3, budget_blocked_role = NULL,
            updated_at = NOW()
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
      url: `#development/${item.id}?project=${encodeURIComponent(item.projectSlug)}`,
      tag: `order-${item.id}`,
    },
    { project: item.projectSlug },
  ).catch(logged('budget', 0));
  return true;
}

/**
 * Gibt wegen Budget blockierte Aufträge frei, sobald ihr Zeitraum wieder Luft hat (Tageslimit am Folgetag, nach
 * Erhöhen oder Entfernen des Limits). Hat ein Rollen-Limit blockiert, zählen zusätzlich die Limits dieser Rolle.
 * Die Aktion „Budget“ verschwindet dabei.
 */
export async function releaseBudgetBlocks(pool: Pool, project: string): Promise<string[]> {
  const blocked = (
    await pool.query<{ id: string; sprintId: string | null; period: BudgetPeriod; role: string | null }>(
      `SELECT id, sprint_id AS "sprintId", budget_blocked AS period, budget_blocked_role AS role
         FROM development_items
        WHERE project_slug = $1 AND status = 'blocked' AND budget_blocked IS NOT NULL`,
      [project],
    )
  ).rows;
  if (!blocked.length) return [];
  const limits = await loadBudgets(pool, project);
  const roleLimits = blocked.some((item) => isBudgetRole(item.role)) ? await loadRoleLimits(pool, project) : [];
  const released: string[] = [];
  for (const item of blocked) {
    const ownLimits = [...limits, ...roleLimits.filter((limit) => limit.role === item.role)];
    const states = await budgetStates(pool, project, { itemId: item.id, sprintId: item.sprintId }, ownLimits);
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
