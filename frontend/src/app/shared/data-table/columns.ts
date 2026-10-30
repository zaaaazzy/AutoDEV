import { BUG_CATEGORIES, CATEGORIES, categoryLabel } from '../labels.js';
import type { DataColumn } from './data-table.component.js';

/** Sortierung: die Ideen-Kategorien wie bisher, danach die nur bei Bugs vorkommenden (Git-Sync, CI, Runner). */
const ORDER: readonly string[] = [...new Set<string>([...CATEGORIES, ...BUG_CATEGORIES])];

/** Einheitliche Kategorie-Spalte (Frontend, Backend, …) für Ideen, Aufträge, Bugs und Sprints. */
export function categoryColumn<T>(category: (row: T) => string | null | undefined): DataColumn<T> {
  return {
    id: 'category',
    header: 'Kategorie',
    value: (row) => categoryLabel(category(row)),
    sortValue: (row) => {
      const index = ORDER.indexOf(category(row) ?? '');
      return index < 0 ? ORDER.length : index;
    },
    badge: (row) => `category category-${category(row) ?? 'none'}`,
  };
}
