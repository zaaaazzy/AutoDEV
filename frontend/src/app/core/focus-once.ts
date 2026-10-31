/**
 * Link-Ziel (`store.focusId`) nur einmal behandeln: aufklappen bzw. hinscrollen beim Öffnen des Links, nicht bei jedem
 * Nachladen im Hintergrund. Effekte, die neben `focusId` auch Projektdaten lesen, laufen sonst alle paar Sekunden neu
 * (Poll von Läufen, Worker, Aufträgen) und reissen die Seite beim Lesen zum Auftrag zurück.
 */
export class FocusOnce {
  private handled: string | null = null;

  /**
   * true genau einmal je Ziel, sobald es auf der Seite steht (`present`). Ohne Ziel wird der Merker gelöscht, damit
   * ein späterer Link auf denselben Eintrag wieder wirkt.
   */
  take(id: string | null, present: boolean): boolean {
    if (!id) {
      this.handled = null;
      return false;
    }
    if (!present || id === this.handled) return false;
    this.handled = id;
    return true;
  }
}

/** Gleiche Menge von IDs: hält abgeleitete Signale stabil, wenn ein Nachladen nichts daran ändert. */
export function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}
