import { CATEGORIES, categoryLabel } from '../labels.js';
import type { DataColumn } from './data-table.component.js';

/** Einheitliche Kategorie-Spalte (Frontend, Backend, …) für Ideen, Aufträge, Bugs und Sprints. */
export function categoryColumn<T>(category: (row: T) => string | null | undefined): DataColumn<T> {
  return {
    id: 'category',
    header: 'Kategorie',
    value: (row) => categoryLabel(category(row)),
    sortValue: (row) => {
      const index = (CATEGORIES as readonly string[]).indexOf(category(row) ?? '');
      return index < 0 ? CATEGORIES.length : index;
    },
    badge: (row) => `category category-${category(row) ?? 'none'}`,
  };
}
