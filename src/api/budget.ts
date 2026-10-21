import type { Router } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import { isRecord, parseProjectSlug } from '../core/validation.js';
import { asCommand } from '../agent/system-agents.js';
import { DEFAULT_RULES, loadRouting, parseRules, ruleLabel, type RoutingRule } from '../agent/model-routing.js';
import {
  BUDGET_PERIODS,
  type BudgetLimit,
  type BudgetPeriod,
  budgetStates,
  loadBudgets,
  releaseBudgetBlocks,
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

export function registerBudgetRoutes(app: Router, pool: Pool): void {
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
