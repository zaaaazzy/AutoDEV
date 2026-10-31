// Typen und Konstanten, die API und Oberfläche teilen. Ohne Imports, damit frontend/tsconfig.app.json die Datei
// einbinden kann; das Backend exportiert sie an den gewohnten Stellen weiter.

/** Budget-Zeiträume: Tag, Sprint, Auftrag. */
export const BUDGET_PERIODS = ['day', 'sprint', 'order'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

/** Modellstufen: lokal (Ollama) und stark (Claude-CLI bzw. ein anderer konfigurierter CLI-Befehl). */
export const MODEL_TIERS = ['local', 'strong'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
/** Ergebnis einer Regel: feste Stufe oder eine Stufe höher (Eskalation) bzw. tiefer (Sparmodus). */
export const RULE_EFFECTS = ['local', 'strong', 'up', 'down'] as const;
export type RuleEffect = (typeof RULE_EFFECTS)[number];

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
