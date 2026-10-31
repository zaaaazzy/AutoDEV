/**
 * Feste Bug-Kategorien (Feld `bugs.bug_category`, Migration 26): worum es bei einem Bug geht. Getrennt vom Bereich
 * `bugs.category` (Frontend, Backend, …), der per Trigger an Aufträge vererbt wird. Der CHECK in der Datenbank nennt
 * genau diese Werte; `src/db/migrations.test.ts` prüft, dass beide übereinstimmen.
 */
export const BUG_CATEGORY_VALUES = ['security', 'git-sync', 'ci', 'ui', 'api', 'agent-guard', 'budget', 'docs'] as const;
export type BugCategoryValue = (typeof BUG_CATEGORY_VALUES)[number];

/** Zustand der Kategorie: vom Modell vorgeschlagen (noch nicht gezählt) oder von einem Menschen bzw. Agent gesetzt. */
export const BUG_CATEGORY_STATES = ['suggested', 'confirmed'] as const;
export type BugCategoryState = (typeof BUG_CATEGORY_STATES)[number];

export function isBugCategoryValue(value: unknown): value is BugCategoryValue {
  return typeof value === 'string' && (BUG_CATEGORY_VALUES as readonly string[]).includes(value);
}
