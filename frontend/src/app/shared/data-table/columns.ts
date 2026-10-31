import { CATEGORIES, categoryLabel } from '../labels.js';
import type { DataColumn } from './data-table.component.js';

/** Werte des Kategoriefilters wie angezeigt: die sechs Kategorien und „Ohne Kategorie“. */
export const CATEGORY_FILTER_OPTIONS: readonly string[] = [...CATEGORIES.map(categoryLabel), categoryLabel(null)];

/**
 * Einheitliche Kategorie-Spalte (Frontend, Backend, …) für Ideen, Aufträge, Bugs und Sprints. Mit `fixedOptions`
 * bietet der Filter immer alle Kategorien an, auch solche, die gerade keine Zeile hat.
 */
export function categoryColumn<T>(
  category: (row: T) => string | null | undefined,
  fixedOptions = false,
): DataColumn<T> {
  return {
    id: 'category',
    header: 'Kategorie',
    value: (row) => categoryLabel(category(row)),
    sortValue: (row) => {
      const index = (CATEGORIES as readonly string[]).indexOf(category(row) ?? '');
      return index < 0 ? CATEGORIES.length : index;
    },
    badge: (row) => `category category-${category(row) ?? 'none'}`,
    ...(fixedOptions ? { filter: 'select' as const, options: CATEGORY_FILTER_OPTIONS } : {}),
  };
}
