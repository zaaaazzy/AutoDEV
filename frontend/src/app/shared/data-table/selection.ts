/** Zustand einer Mehrfachauswahl bezogen auf die sichtbaren, wählbaren Zeilen. */
export function selectionState(visible: string[], selected: ReadonlySet<string>): 'none' | 'some' | 'all' {
  const count = visible.filter((id) => selected.has(id)).length;
  if (!count) return 'none';
  return count === visible.length ? 'all' : 'some';
}

/** Alle sichtbaren auswählen; sind schon alle gewählt, diese abwählen. Unsichtbare Auswahl bleibt erhalten. */
export function toggleAll(visible: string[], selected: ReadonlySet<string>): ReadonlySet<string> {
  const next = new Set(selected);
  if (selectionState(visible, selected) === 'all') for (const id of visible) next.delete(id);
  else for (const id of visible) next.add(id);
  return next;
}
