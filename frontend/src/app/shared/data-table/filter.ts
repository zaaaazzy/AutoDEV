/** Auswahlfilter einer Spalte: ohne Auswahl passt jede Zeile, sonst nur die gewählten Werte (wie angezeigt). */
export function matchesSelection(value: unknown, wanted: readonly string[] | undefined): boolean {
  return !wanted?.length || wanted.includes(String(value ?? ''));
}

/**
 * Werte für das Filtermenü mit Anzahl. Mit festen Optionen stehen diese in ihrer Reihenfolge da – auch ohne
 * Treffer, damit der Filter immer dieselben Werte anbietet; Werte außerhalb der Optionen folgen danach.
 */
export function filterFacets(
  unique: ReadonlyMap<unknown, number>,
  options?: readonly string[],
): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const [value, count] of unique) {
    const key = String(value);
    if (key !== '') counts.set(key, (counts.get(key) ?? 0) + Number(count));
  }
  const rest = [...counts.entries()]
    .filter(([value]) => !options?.includes(value))
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => a.value.localeCompare(b.value, 'de', { numeric: true }));
  return [...(options ?? []).map((value) => ({ value, count: counts.get(value) ?? 0 })), ...rest];
}
