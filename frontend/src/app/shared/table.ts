export type SortDirection = 'asc' | 'desc';
export type SortRank = string | number | null;

export interface SortState<Key> {
  key: Key;
  dir: SortDirection;
}

/** Klick auf dieselbe Spalte kehrt die Richtung um, sonst beginnt die neue Spalte aufsteigend. */
export function toggleSort<Key>(sort: SortState<Key>, key: Key): SortState<Key> {
  return { key, dir: sort.key === key && sort.dir === 'asc' ? 'desc' : 'asc' };
}

/** `null` sortiert immer ans Ende. */
export function compareRanks(a: SortRank, b: SortRank, dir: SortDirection): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return (a < b ? -1 : 1) * (dir === 'asc' ? 1 : -1);
}

export function includesText(value: string | null | undefined, needle: string | undefined): boolean {
  return !needle || (value ?? '').toLowerCase().includes(needle.toLowerCase());
}

export function toggleListValue(current: string[] | undefined, value: string, checked: boolean): string[] {
  const list = current ?? [];
  return checked ? [...list, value] : list.filter((entry) => entry !== value);
}
