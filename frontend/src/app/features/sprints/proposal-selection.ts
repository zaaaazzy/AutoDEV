/**
 * Auswahl im Sprint-Vorschlag nach einem Neuladen: Die Vorgabe des Servers gilt nur beim ersten Laden, nach einem
 * Projektwechsel oder wenn sich die vorgeschlagenen Aufträge geändert haben (z. B. nach dem Übernehmen). Sonst bleibt
 * die Auswahl des Nutzers erhalten.
 */
export function proposalSelection(
  previous: { slug: string; ids: readonly string[]; picked: ReadonlySet<string> } | null,
  slug: string,
  items: readonly { id: string; selected: boolean }[],
): ReadonlySet<string> {
  const sameItems =
    !!previous &&
    previous.slug === slug &&
    previous.ids.length === items.length &&
    items.every((item, index) => item.id === previous.ids[index]);
  if (sameItems) return previous.picked;
  return new Set(items.filter((item) => item.selected).map((item) => item.id));
}
