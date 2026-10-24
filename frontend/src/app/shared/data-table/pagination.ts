/** Ab so vielen Zeilen teilt die Tabelle in Seiten auf. */
export const PAGE_SIZE = 20;

/** Anzahl Seiten; eine leere Tabelle hat trotzdem eine (leere) Seite. */
export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size));
}

/** Gewünschte Seite auf die vorhandenen begrenzen (z. B. nachdem ein Filter Zeilen ausgeblendet hat). */
export function clampPage(page: number, total: number, size: number): number {
  return Math.min(Math.max(0, page), pageCount(total, size) - 1);
}

/** Bereich der Seite für „21–40 von 57“, 1-basiert und inklusive. */
export function pageRange(page: number, total: number, size: number): { from: number; to: number } {
  if (!total) return { from: 0, to: 0 };
  const from = clampPage(page, total, size) * size;
  return { from: from + 1, to: Math.min(total, from + size) };
}

/**
 * Seitenknöpfe (0-basiert) mit Lücken: erste und letzte Seite immer, um die aktuelle je ein Nachbar.
 * Eine Lücke ersetzt nur mindestens zwei Seiten – sonst steht die eine Seite selbst da.
 * Ergebnis hat so höchstens sieben Einträge, die Leiste springt beim Blättern nicht.
 */
export function pageItems(page: number, count: number): (number | 'gap')[] {
  if (count <= 7) return Array.from({ length: count }, (_, index) => index);
  const current = Math.min(Math.max(0, page), count - 1);
  // Fenster von drei Seiten, am Rand auf vier verbreitert, damit immer sieben Einträge entstehen.
  const [start, end] =
    current <= 3 ? [1, 4] : current >= count - 4 ? [count - 5, count - 2] : [current - 1, current + 1];
  const items: (number | 'gap')[] = [0];
  if (start > 1) items.push('gap');
  for (let index = start; index <= end; index++) items.push(index);
  if (end < count - 2) items.push('gap');
  items.push(count - 1);
  return items;
}

/** Zeile unter der Tabelle: „57 Einträge“, „5 von 12 Einträgen“, „21–40 von 57 Einträgen · gefiltert aus 120“. */
export function countText(range: { from: number; to: number } | null, shown: number, total: number): string {
  const filtered = shown !== total;
  if (!range) {
    if (filtered) return `${shown} von ${total} ${total === 1 ? 'Eintrag' : 'Einträgen'}`;
    return `${total} ${total === 1 ? 'Eintrag' : 'Einträge'}`;
  }
  const text = `${range.from}–${range.to} von ${shown} Einträgen`;
  return filtered ? `${text} · gefiltert aus ${total}` : text;
}
