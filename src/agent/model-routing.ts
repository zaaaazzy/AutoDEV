import type { Pool } from 'pg';
import { asCommand } from './system-agents.js';

/** Modellstufen: lokal (Ollama) und stark (Claude-CLI bzw. ein anderer konfigurierter CLI-Befehl). */
export const MODEL_TIERS = ['local', 'strong'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
/** Ergebnis einer Regel: feste Stufe oder eine Stufe höher (Eskalation) bzw. tiefer (Sparmodus). */
export const RULE_EFFECTS = ['local', 'strong', 'up', 'down'] as const;
export type RuleEffect = (typeof RULE_EFFECTS)[number];

export const CATEGORIES = ['frontend', 'backend', 'fullstack', 'infrastructure', 'docs', 'security'] as const;

/** Alle angegebenen Teile müssen zutreffen; eine leere Bedingung trifft immer zu. */
export interface RoutingCondition {
  categories?: string[];
  /** Schätzung (Stunden) größer als … */
  minHours?: number;
  /** Schätzung (Stunden) kleiner als … */
  maxHours?: number;
  /** retry_count mindestens … */
  minRetries?: number;
  /** Budget zu mehr als … % verbraucht */
  minBudgetPercent?: number;
}

export interface RoutingRule {
  condition: RoutingCondition;
  tier: RuleEffect;
}

export interface RoutingInput {
  category: string | null;
  effortHours: number | null;
  retryCount: number;
  /** Höchster Anteil eines Budgets in Prozent (0 ohne Budget). */
  budgetPercent: number;
}

export interface RoutingDecision {
  /** null = keine Regel greift, die Modellwahl je Rolle bleibt. */
  tier: ModelTier | null;
  /** Greifende Regel(n), z. B. „docs → lokal“. */
  rule: string | null;
}

/**
 * Standardregeln, solange ein Projekt keine eigenen gespeichert hat. Reihenfolge = Priorität für die festen Stufen
 * (erste zutreffende gewinnt); bei „höher/tiefer“ gewinnt die letzte zutreffende – hier die Budget-Bremse vor der
 * Eskalation nach einem Retry.
 */
export const DEFAULT_RULES: RoutingRule[] = [
  { condition: { categories: ['security'] }, tier: 'strong' },
  { condition: { categories: ['docs'] }, tier: 'local' },
  { condition: { maxHours: 1 }, tier: 'local' },
  { condition: { categories: ['backend'], minHours: 4 }, tier: 'strong' },
  { condition: { minRetries: 1 }, tier: 'up' },
  { condition: { minBudgetPercent: 80 }, tier: 'down' },
];

const EFFECT_LABELS: Record<RuleEffect, string> = {
  local: 'lokal',
  strong: 'stark',
  up: 'eine Stufe höher',
  down: 'eine Stufe tiefer',
};

const hours = (value: number): string => `${String(value).replace('.', ',')} h`;

/** Kurzform einer Regel für Lauf-Detail und Einstellungen, z. B. „backend, Schätzung > 4 h → stark“. */
export function ruleLabel(rule: RoutingRule): string {
  const { categories, minHours, maxHours, minRetries, minBudgetPercent } = rule.condition;
  const parts = [
    categories?.length ? categories.join('/') : '',
    minHours !== undefined ? `Schätzung > ${hours(minHours)}` : '',
    maxHours !== undefined ? `Schätzung < ${hours(maxHours)}` : '',
    minRetries !== undefined ? `retry ≥ ${minRetries}` : '',
    minBudgetPercent !== undefined ? `Budget > ${minBudgetPercent} %` : '',
  ].filter(Boolean);
  return `${parts.join(', ') || 'immer'} → ${EFFECT_LABELS[rule.tier]}`;
}

export function matchesCondition(condition: RoutingCondition, input: RoutingInput): boolean {
  const { categories, minHours, maxHours, minRetries, minBudgetPercent } = condition;
  if (categories?.length && !(input.category && categories.includes(input.category))) return false;
  if (minHours !== undefined && !(input.effortHours !== null && input.effortHours > minHours)) return false;
  if (maxHours !== undefined && !(input.effortHours !== null && input.effortHours < maxHours)) return false;
  if (minRetries !== undefined && input.retryCount < minRetries) return false;
  if (minBudgetPercent !== undefined && !(input.budgetPercent > minBudgetPercent)) return false;
  return true;
}

/** Zwei Stufen: höher ist immer „stark“, tiefer immer „lokal“ (an der Grenze bleibt die Stufe). */
const shift = (effect: 'up' | 'down'): ModelTier => (effect === 'up' ? 'strong' : 'local');

/**
 * Wählt die Modellstufe: Die erste zutreffende Regel mit fester Stufe (lokal/stark) bestimmt die Grundstufe; danach
 * verschieben alle zutreffenden Regeln „eine Stufe höher/tiefer“ sie in ihrer Reihenfolge (Eskalation, Sparmodus).
 * Bei nur zwei Stufen heißt das: Von den Verschiebungen gewinnt die letzte zutreffende Regel (bewusst, damit eine
 * spätere Budget-Bremse eine frühere Eskalation übersteuert).
 * Ohne Grundstufe gilt die Modellwahl je Rolle als Ausgangspunkt: höher = stark, tiefer = lokal.
 */
export function routeModel(rules: RoutingRule[], input: RoutingInput): RoutingDecision {
  let tier: ModelTier | null = null;
  const applied: string[] = [];
  const base = rules.find(
    (rule) => (rule.tier === 'local' || rule.tier === 'strong') && matchesCondition(rule.condition, input),
  );
  if (base) {
    tier = base.tier as ModelTier;
    applied.push(ruleLabel(base));
  }
  for (const rule of rules) {
    if ((rule.tier !== 'up' && rule.tier !== 'down') || !matchesCondition(rule.condition, input)) continue;
    tier = shift(rule.tier);
    applied.push(ruleLabel(rule));
  }
  return { tier, rule: applied.length ? applied.join(' · ') : null };
}

const positive = (value: unknown, max: number): number | undefined | string => {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= max ? number : 'invalid';
};

/** Prüft Regeln aus der Oberfläche; liefert die bereinigten Regeln oder eine Fehlermeldung. */
export function parseRules(value: unknown): RoutingRule[] | string {
  if (!Array.isArray(value)) return 'Routing-Regeln: Liste erwartet.';
  if (value.length > 30) return 'Routing-Regeln: höchstens 30 Regeln.';
  const rules: RoutingRule[] = [];
  for (const [index, raw] of value.entries()) {
    const fail = (message: string): string => `Routing-Regel ${index + 1}: ${message}`;
    if (typeof raw !== 'object' || raw === null) return fail('ungültig.');
    const { condition: rawCondition, tier } = raw as { condition?: unknown; tier?: unknown };
    if (!RULE_EFFECTS.includes(tier as RuleEffect)) return fail('Stufe fehlt.');
    const source = (typeof rawCondition === 'object' && rawCondition !== null ? rawCondition : {}) as Record<
      string,
      unknown
    >;
    const condition: RoutingCondition = {};
    if (source.categories !== undefined && source.categories !== null) {
      if (
        !Array.isArray(source.categories) ||
        !source.categories.every((entry) => CATEGORIES.includes(entry as (typeof CATEGORIES)[number]))
      )
        return fail('unbekannte Kategorie.');
      if (source.categories.length) condition.categories = [...new Set(source.categories as string[])];
    }
    for (const [key, max] of [
      ['minHours', 10_000],
      ['maxHours', 10_000],
      ['minRetries', 100],
      ['minBudgetPercent', 100],
    ] as const) {
      const parsed = positive(source[key], max);
      if (parsed === 'invalid') return fail('Zahlen müssen zwischen 0 und dem Höchstwert liegen.');
      if (parsed !== undefined) condition[key] = parsed as number;
    }
    rules.push({ condition, tier: tier as RuleEffect });
  }
  return rules;
}

export interface TierModels {
  /** Ollama-Modell der Stufe „lokal“ (null = nicht konfiguriert). */
  local: string | null;
  /** CLI-Befehl der Stufe „stark“, z. B. ["claude", "-p"] (null = nicht konfiguriert). */
  strong: string[] | null;
}

export interface ProjectRouting {
  rules: RoutingRule[];
  /** false = Standardregeln. */
  customized: boolean;
  models: TierModels;
}

/** Regeln und Stufen-Modelle eines Projekts (ohne eigene Regeln die Standardregeln). */
export async function loadRouting(pool: Pool, project: string): Promise<ProjectRouting> {
  const [settings, rules] = await Promise.all([
    pool.query<{ customized: boolean; local: string | null; strong: unknown }>(
      `SELECT routing_customized AS customized, routing_local_model AS local, routing_strong_command AS strong
         FROM projects WHERE slug = $1`,
      [project],
    ),
    pool.query<{ condition: RoutingCondition; tier: RuleEffect }>(
      `SELECT condition, tier FROM routing_rules WHERE project_slug = $1 ORDER BY position, id`,
      [project],
    ),
  ]);
  const row = settings.rows[0];
  const customized = Boolean(row?.customized);
  const parsed = parseRules(rules.rows);
  return {
    rules: customized ? (typeof parsed === 'string' ? [] : parsed) : DEFAULT_RULES,
    customized,
    models: { local: row?.local?.trim() || null, strong: asCommand(row?.strong) },
  };
}

/** Lesbarer Modellname eines CLI-Befehls: „claude (opus)“ mit --model, sonst das Programm. */
export function describeCommand(command: string[]): string {
  const program = (command[0] ?? '').split(/[\\/]/).pop() ?? '';
  const index = command.findIndex((part) => part === '--model' || part === '-m' || part.startsWith('--model='));
  const flag = index < 0 ? '' : (command[index] ?? '');
  const model = index < 0 ? null : flag.includes('=') ? flag.split('=')[1] : (command[index + 1] ?? null);
  return model ? `${program} (${model})` : program;
}

/** Rollen, deren Modell das Routing wählt; der Tester führt die Projekttests aus und bleibt unverändert. */
export function routable(role: string): boolean {
  return role !== 'tester';
}
