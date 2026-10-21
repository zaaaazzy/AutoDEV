/** Mehrfachauswahl „Aufträge hinzufügen“: welche offenen bzw. abgebrochenen Aufträge in den Sprint sollen. */

/** Gewählte Aufträge in der angezeigten Reihenfolge; nicht mehr verfügbare (inzwischen eingeplant) fallen weg. */
export function pickInOrder<T extends { id: string }>(available: readonly T[], selected: ReadonlySet<string>): T[] {
  return available.filter((item) => selected.has(item.id));
}
