type SortValue = string | number | null | undefined;

const isEmpty = (value: SortValue): boolean => value === null || value === undefined || value === '';

/**
 * Vergleich zweier Sortierwerte wie in der Tabelle: Zahlen numerisch, sonst deutsch und mit Zahlen im Text.
 * Mit `emptyLast` stehen leere Werte in beiden Richtungen hinten; weil TanStack das Ergebnis bei absteigender
 * Sortierung umdreht, wird der Vergleich für leere Werte dann vorab gespiegelt.
 */
export function compareSortValues(a: SortValue, b: SortValue, options: { desc?: boolean; emptyLast?: boolean } = {}) {
  if (options.emptyLast && (isEmpty(a) || isEmpty(b))) {
    if (isEmpty(a) && isEmpty(b)) return 0;
    return (isEmpty(a) ? 1 : -1) * (options.desc ? -1 : 1);
  }
  const left = a ?? '';
  const right = b ?? '';
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right), 'de', { numeric: true, sensitivity: 'base' });
}
