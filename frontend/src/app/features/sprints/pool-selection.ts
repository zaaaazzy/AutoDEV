/** Mehrfachauswahl unter dem Sprint-Board: welche offenen bzw. abgebrochenen Aufträge in den Sprint sollen. */

/** Einen Auftrag an- bzw. abwählen. */
export function toggleId(selected: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

/** Ganze Gruppe: sind schon alle gewählt, werden sie abgewählt, sonst alle gewählt. */
export function toggleGroup(selected: ReadonlySet<string>, ids: readonly string[]): ReadonlySet<string> {
  const next = new Set(selected);
  if (ids.length && ids.every((id) => next.has(id))) ids.forEach((id) => next.delete(id));
  else ids.forEach((id) => next.add(id));
  return next;
}

/** Status der Gruppen-Checkbox. */
export function groupState(selected: ReadonlySet<string>, ids: readonly string[]): 'none' | 'some' | 'all' {
  const count = ids.filter((id) => selected.has(id)).length;
  return count === 0 ? 'none' : count === ids.length ? 'all' : 'some';
}

/** Gewählte Aufträge in der angezeigten Reihenfolge; nicht mehr verfügbare (inzwischen eingeplant) fallen weg. */
export function pickInOrder<T extends { id: string }>(available: readonly T[], selected: ReadonlySet<string>): T[] {
  return available.filter((item) => selected.has(item.id));
}
