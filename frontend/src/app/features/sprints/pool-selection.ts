/** Mehrfachauswahl „Aufträge hinzufügen“: welche offenen bzw. abgebrochenen Aufträge in den Sprint sollen. */
import { computed, linkedSignal, type WritableSignal } from '@angular/core';

/** Gewählte Aufträge in der angezeigten Reihenfolge; nicht mehr verfügbare (inzwischen eingeplant) fallen weg. */
export function pickInOrder<T extends { id: string }>(available: readonly T[], selected: ReadonlySet<string>): T[] {
  return available.filter((item) => selected.has(item.id));
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
