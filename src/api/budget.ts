import type { Router } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import { isRecord, parseProjectSlug } from '../core/validation.js';
import { asCommand } from '../agent/system-agents.js';
import { DEFAULT_RULES, loadRouting, parseRules, ruleLabel, type RoutingRule } from '../agent/model-routing.js';
import { localDay } from '../core/time-zone.js';
import {
  BUDGET_PERIODS,
  BUDGET_ROLES,
  type BudgetLimit,
  type BudgetPeriod,
  type BudgetRole,
  budgetStates,
  isBudgetRole,
  loadBudgets,
  loadRoleLimits,
  releaseBudgetBlocks,
  type Spend,
  spendByRole,
  sprintStart,
  usagePercent,
  WARN_PERCENT,
} from '../runner/budget.js';

export const CURRENCIES = ['USD', 'CHF'] as const;
export type Currency = (typeof CURRENCIES)[number];
const CURRENCY_KEY = 'budget_currency';
const RATE_KEY = 'budget_chf_per_usd';
/** Fester Kurs (kein Live-Kurs), bis in den Einstellungen ein anderer hinterlegt ist. */
export const DEFAULT_CHF_PER_USD = 0.8;
const MAX_TOKENS = 1e11;
const MAX_COST = 1e6;

export interface Display {
  currency: Currency;
  /** CHF je USD */
  chfPerUsd: number;
}

/** Anzeigewährung und fester Wechselkurs (app_settings, für alle Projekte). */
export async function loadDisplay(pool: Pool): Promise<Display> {
  const rows = (
    await pool.query<{ key: string; value: string }>(`SELECT key, value FROM app_settings WHERE key = ANY($1)`, [
      [CURRENCY_KEY, RATE_KEY],
    ])
  ).rows;
  const value = (key: string) => rows.find((row) => row.key === key)?.value;
  const rate = Number(value(RATE_KEY));
  return {
    currency: value(CURRENCY_KEY) === 'CHF' ? 'CHF' : 'USD',
    chfPerUsd: Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_CHF_PER_USD,
  };
}

const limitNumber = (value: unknown, max: number): number | null | 'invalid' => {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= max ? number : 'invalid';
};

export interface BudgetInput {
  limits?: Partial<Record<BudgetPeriod, { maxTokens: number | null; maxCostUsd: number | null }>>;
  display?: Display;
  /** null = Standardregeln */
  rules?: RoutingRule[] | null;
  localModel?: string | null;
  strongCommand?: string[] | null;
}

/** Prüft die Budget-Einstellungen aus der Oberfläche; liefert die bereinigten Werte oder eine Fehlermeldung. */
export function parseBudgetInput(body: unknown): BudgetInput | string {
  if (!isRecord(body)) return 'Ungültige Anfrage.';
  const input: BudgetInput = {};
  if (body.limits !== undefined) {
    if (!isRecord(body.limits)) return 'Limits: ungültig.';
    input.limits = {};
    for (const period of BUDGET_PERIODS) {
      const raw = body.limits[period];
      if (raw === undefined) continue;
      const entry = isRecord(raw) ? raw : {};
      const maxTokens = limitNumber(entry.maxTokens, MAX_TOKENS);
      const maxCostUsd = limitNumber(entry.maxCostUsd, MAX_COST);
      if (maxTokens === 'invalid' || maxCostUsd === 'invalid')
        return 'Limits: leer lassen (unbegrenzt) oder eine positive Zahl angeben.';
      input.limits[period] = { maxTokens: maxTokens === null ? null : Math.round(maxTokens), maxCostUsd };
    }
  }
  if (body.currency !== undefined || body.chfPerUsd !== undefined) {
    if (!CURRENCIES.includes(body.currency as Currency)) return 'Währung: USD oder CHF.';
    const rate = Number(body.chfPerUsd);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 100) return 'Wechselkurs: eine positive Zahl (CHF je USD).';
    input.display = { currency: body.currency as Currency, chfPerUsd: rate };
  }
  if (body.rules !== undefined) {
    if (body.rules === null) input.rules = null;
    else {
      const rules = parseRules(body.rules);
      if (typeof rules === 'string') return rules;
      input.rules = rules;
    }
  }
  if (body.localModel !== undefined) {
    if (body.localModel !== null && (typeof body.localModel !== 'string' || body.localModel.length > 200))
      return 'Lokales Modell: Name des Ollama-Modells, z. B. qwen3.5:9b.';
    input.localModel = typeof body.localModel === 'string' && body.localModel.trim() ? body.localModel.trim() : null;
  }
  if (body.strongCommand !== undefined) {
    if (body.strongCommand === null || (Array.isArray(body.strongCommand) && !body.strongCommand.length))
      input.strongCommand = null;
    else {
      const command = asCommand(body.strongCommand);
      if (!command || command.length > 30 || command.some((part) => !part.trim() || part.length > 500))
        return 'Starkes Modell: CLI-Befehl als Liste, z. B. claude -p --model opus.';
      input.strongCommand = command.map((part) => part.trim());
    }
  }
  return input;
}

/** Speichert Limits, Währung und Routing; leere Limits entfernen den Zeitraum (= keine Prüfung). */
export async function saveBudget(pool: Pool, project: string, input: BudgetInput): Promise<void> {
  for (const [period, limit] of Object.entries(input.limits ?? {}) as [BudgetPeriod, BudgetLimit][]) {
    if (limit.maxTokens === null && limit.maxCostUsd === null)
      await pool.query(`DELETE FROM budgets WHERE project_slug = $1 AND period = $2`, [project, period]);
    else
      await pool.query(
        `INSERT INTO budgets (project_slug, period, max_tokens, max_cost_usd) VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_slug, period) DO UPDATE SET max_tokens = EXCLUDED.max_tokens, max_cost_usd = EXCLUDED.max_cost_usd`,
        [project, period, limit.maxTokens, limit.maxCostUsd],
      );
  }
  if (input.display) {
    const upsert = `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    await pool.query(upsert, [CURRENCY_KEY, input.display.currency]);
    await pool.query(upsert, [RATE_KEY, String(input.display.chfPerUsd)]);
  }
  if (input.rules !== undefined) {
    await pool.query(`DELETE FROM routing_rules WHERE project_slug = $1`, [project]);
    for (const [position, rule] of (input.rules ?? []).entries()) {
      await pool.query(
        `INSERT INTO routing_rules (project_slug, position, condition, tier) VALUES ($1, $2, $3::jsonb, $4)`,
        [project, position, JSON.stringify(rule.condition), rule.tier],
      );
    }
    await pool.query(`UPDATE projects SET routing_customized = $2 WHERE slug = $1`, [project, input.rules !== null]);
  }
  if (input.localModel !== undefined)
    await pool.query(`UPDATE projects SET routing_local_model = $2 WHERE slug = $1`, [project, input.localModel]);
  if (input.strongCommand !== undefined)
    await pool.query(`UPDATE projects SET routing_strong_command = $2::jsonb WHERE slug = $1`, [
      project,
      input.strongCommand === null ? null : JSON.stringify(input.strongCommand),
    ]);
}

const withLabels = (rules: RoutingRule[]) => rules.map((rule) => ({ ...rule, label: ruleLabel(rule) }));

/** Einstellungen und aktueller Stand (Tag, aktiver Sprint) für Einstellungen, Dashboard und Statistik. */
export async function collectBudget(pool: Pool, project: string): Promise<Record<string, unknown>> {
  const [limits, display, routing, models] = await Promise.all([
    loadBudgets(pool, project),
    loadDisplay(pool),
    loadRouting(pool, project),
    pool.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'ollama_models'`),
  ]);
  const states = await budgetStates(pool, project, {}, limits);
  let ollamaModels: string[] = [];
  try {
    const parsed: unknown = JSON.parse(models.rows[0]?.value ?? '[]');
    if (Array.isArray(parsed)) ollamaModels = parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    ollamaModels = [];
  }
  return {
    limits: Object.fromEntries(
      BUDGET_PERIODS.map((period) => {
        const limit = limits.find((entry) => entry.period === period);
        return [period, { maxTokens: limit?.maxTokens ?? null, maxCostUsd: limit?.maxCostUsd ?? null }];
      }),
    ),
    ...display,
    warnPercent: WARN_PERCENT,
    status: states.map(({ period, spend, limit, percent }) => ({ period, spend, limit, percent })),
    routing: {
      rules: withLabels(routing.rules),
      customized: routing.customized,
      defaults: withLabels(DEFAULT_RULES),
      localModel: routing.models.local,
      strongCommand: routing.models.strong,
    },
    ollamaModels,
  };
}

/** Neue Token-Limits einer Rolle je Zeitraum: Zahl = Grenze, null = Grenze entfernen; fehlender Zeitraum = unverändert. */
export type RoleLimitsInput = Partial<Record<BudgetPeriod, number | null>>;

/** Prüft den Body von PUT /budget/roles/:role ({ day, sprint, order } mit { maxTokens } oder null). */
export function parseRoleLimitsInput(body: unknown): RoleLimitsInput | string {
  if (!isRecord(body)) return 'Ungültige Anfrage.';
  const unknown = Object.keys(body).find((key) => !(BUDGET_PERIODS as readonly string[]).includes(key));
  if (unknown !== undefined) return `Unbekannter Zeitraum „${unknown}“: erlaubt sind day, sprint und order.`;
  const input: RoleLimitsInput = {};
  for (const period of BUDGET_PERIODS) {
    const raw = body[period];
    if (raw === undefined) continue;
    if (raw !== null && !isRecord(raw)) return `${period}: { "maxTokens": <Zahl> } oder null angeben.`;
    const maxTokens = raw === null ? null : limitNumber(raw.maxTokens, MAX_TOKENS);
    if (maxTokens === 'invalid') return `${period}: maxTokens muss eine positive Zahl sein (oder null für unbegrenzt).`;
    input[period] = maxTokens === null ? null : Math.max(1, Math.round(maxTokens));
  }
  if (!Object.keys(input).length) return 'Mindestens einen Zeitraum (day, sprint oder order) angeben.';
  return input;
}

/** Speichert die Limits einer Rolle in einer Transaktion; null entfernt die Zeile (= keine Grenze, keine Prüfung). */
export async function saveRoleLimits(pool: Pool, project: string, role: BudgetRole, input: RoleLimitsInput) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [period, maxTokens] of Object.entries(input) as [BudgetPeriod, number | null][]) {
      if (maxTokens === null)
        await client.query(`DELETE FROM budget_role_limits WHERE project_slug = $1 AND role = $2 AND period = $3`, [
          project,
          role,
          period,
        ]);
      else
        await client.query(
          `INSERT INTO budget_role_limits (project_slug, role, period, max_tokens) VALUES ($1, $2, $3, $4)
           ON CONFLICT (project_slug, role, period) DO UPDATE SET max_tokens = EXCLUDED.max_tokens`,
          [project, role, period, maxTokens],
        );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

interface RolePeriodStatus {
  maxTokens: number | null;
  /** Verbrauch der Rolle im laufenden Zeitraum; null beim Auftragslimit (hängt am einzelnen Auftrag) bzw. ohne Sprint. */
  spend: Spend | null;
  percent: number | null;
}

/** Limits und aktueller Verbrauch (heute, aktiver Sprint) aller Agent-Rollen des Projekts. */
export async function collectRoleBudget(pool: Pool, project: string): Promise<Record<string, unknown>> {
  const [limits, sprint] = await Promise.all([loadRoleLimits(pool, project), sprintStart(pool, project, null)]);
  const [today, sprintSpend] = await Promise.all([
    spendByRole(pool, project, localDay().since),
    sprint ? spendByRole(pool, project, sprint.since) : Promise.resolve(null),
  ]);
  const status = (role: BudgetRole, period: BudgetPeriod): RolePeriodStatus => {
    const limit = limits.find((entry) => entry.role === role && entry.period === period);
    const spent = period === 'day' ? today : period === 'sprint' ? sprintSpend : null;
    const spend = spent ? (spent.get(role) ?? { tokens: 0, costUsd: 0 }) : null;
    return {
      maxTokens: limit?.maxTokens ?? null,
      spend,
      percent: limit && spend ? usagePercent(spend, limit) : null,
    };
  };
  return {
    warnPercent: WARN_PERCENT,
    sprintId: sprint?.id ?? null,
    roles: BUDGET_ROLES.map((role) => ({
      role,
      limits: Object.fromEntries(BUDGET_PERIODS.map((period) => [period, status(role, period)])),
    })),
  };
}

export function registerBudgetRoutes(app: Router, pool: Pool): void {
  app.get('/projects/:slug/budget/roles', access({ tenant: 'project' }), async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
    response.json(await collectRoleBudget(pool, slug));
  });

  app.put(
    '/projects/:slug/budget/roles/:role',
    access({ role: 'admin', tenant: 'project' }),
    async (request, response) => {
      const slug = parseProjectSlug(request.params.slug ?? '');
      if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
      const role = request.params.role;
      if (!isBudgetRole(role))
        return void response
          .status(400)
          .json({ message: `Unbekannte Agent-Rolle „${role ?? ''}“: erlaubt sind ${BUDGET_ROLES.join(', ')}.` });
      const input = parseRoleLimitsInput(request.body);
      if (typeof input === 'string') return void response.status(400).json({ message: input });
      const exists = await pool.query('SELECT 1 FROM projects WHERE slug = $1', [slug]);
      if (!exists.rows.length) return void response.status(404).json({ message: 'Projekt nicht gefunden.' });
      await saveRoleLimits(pool, slug, role, input);
      // Wie beim Projektbudget: wegen Budget wartende Aufträge sofort freigeben, wenn das Limit wieder reicht.
      await releaseBudgetBlocks(pool, slug);
      response.json(await collectRoleBudget(pool, slug));
    },
  );

  app.get('/projects/:slug/budget', access({ tenant: 'project' }), async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
    response.json(await collectBudget(pool, slug));
  });

  app.put('/projects/:slug/budget', access({ role: 'admin', tenant: 'project' }), async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
    const exists = await pool.query('SELECT 1 FROM projects WHERE slug = $1', [slug]);
    if (!exists.rows.length) return void response.status(404).json({ message: 'Projekt nicht gefunden.' });
    const input = parseBudgetInput(request.body);
    if (typeof input === 'string') return void response.status(400).json({ message: input });
    await saveBudget(pool, slug, input);
    // Limit erhöht oder entfernt: wegen Budget wartende Aufträge sofort freigeben (Aktion „Budget“ verschwindet).
    await releaseBudgetBlocks(pool, slug);
    response.json(await collectBudget(pool, slug));
  });
}
