/** Mehrfachauswahl „Aufträge hinzufügen“: welche offenen bzw. abgebrochenen Aufträge in den Sprint sollen. */
import { computed, linkedSignal, type WritableSignal } from '@angular/core';
import { DEVELOPMENT_STATUS } from '../../core/models.js';

/** Gewählte Aufträge in der angezeigten Reihenfolge; nicht mehr verfügbare (inzwischen eingeplant) fallen weg. */
export function pickInOrder<T extends { id: string }>(available: readonly T[], selected: ReadonlySet<string>): T[] {
  return available.filter((item) => selected.has(item.id));
}

/** Abgebrochen = aus einem Sprint genommen oder blockiert (wie `aborted` in der Route take-into-sprint). */
export function isAborted(item: { removedFromSprintAt?: string | null; status: string }): boolean {
  return !!item.removedFromSprintAt || item.status === DEVELOPMENT_STATUS.blocked;
}

/** Hinweis an gesperrten abgebrochenen Aufträgen; der Server antwortet ohne „Ausführen“ mit 403. */
export const NEEDS_RUN = 'Abgebrochene Aufträge neu einplanen braucht die Rolle „Agents ausführen“.';

/**
 * Wählbar in „Aufträge hinzufügen“: offene mit „Planung“, abgebrochene nur zusätzlich mit „Ausführen“ – neu einplanen
 * ist ein erneuter Versuch. `canRun` wird bei jedem Aufruf gelesen, ein Rollenwechsel wirkt also sofort.
 */
export function poolSelectable(
  canRun: () => boolean,
): (item: { removedFromSprintAt?: string | null; status: string }) => boolean {
  return (item) => !isAborted(item) || canRun();
}

/**
 * Offen-Zustand von „Aufträge hinzufügen“: bei leerem Sprint offen, sonst zu; von Hand änderbar. Quelle ist nur
 * „leer ja/nein“: Die Auftragsliste ist bei jedem Nachladen (Agent-Läufe alle 3 s, Commits) ein neues Array. Hinge
 * der Zustand direkt an ihr, rechnete linkedSignal jedes Mal neu und klappte eine von Hand geöffnete Liste wieder zu.
 * Erst wenn der Sprint leer wird oder nicht mehr leer ist, gilt wieder die Vorgabe.
 */
export function poolOpenState(orders: () => readonly unknown[]): WritableSignal<boolean> {
  const sprintEmpty = computed(() => !orders().length);
  return linkedSignal(() => sprintEmpty());
}
