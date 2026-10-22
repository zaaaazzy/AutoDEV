import type { ReviewSlot } from '../../core/models.js';
import { reviewStatusText } from '../sprints/review-launch.js';

/** Hover-Text zur optischen Abnahme: wozu sie dient und was die Freigabe bewirkt. */
export const VISUAL_REVIEW_WHY =
  'Optische Abnahme der Frontend-Änderungen: Den Auftrag in einer Umgebung starten, die Seiten optisch kontrollieren ' +
  'und danach freigeben. Erst mit der Freigabe findet diese Version den Weg in die produktive Umgebung.';

/** Farbe des Statuspunkts einer Umgebung. */
export type SlotTone = 'off' | 'idle' | 'busy' | 'ok' | 'error';

export function slotTone(slot: Pick<ReviewSlot, 'enabled' | 'status'>): SlotTone {
  if (!slot.enabled) return 'off';
  switch (slot.status) {
    case 'running':
      return 'ok';
    case 'failed':
      return 'error';
    case 'idle':
      return 'idle';
    default:
      return 'busy';
  }
}

/** Die Umgebung zeigt diesen Auftrag (läuft, startet oder ist damit gescheitert). */
export function showsOrder(slot: Pick<ReviewSlot, 'developmentId' | 'status'>, orderId: string): boolean {
  return slot.developmentId === orderId && slot.status !== 'idle' && slot.status !== 'stopping';
}

/** Statuszeile einer Umgebung: gesperrt, frei oder der Status des Containers. */
export function slotStatusText(slot: Pick<ReviewSlot, 'enabled' | 'status' | 'message'>): string {
  if (!slot.enabled) return 'gesperrt';
  return reviewStatusText(slot);
}

/**
 * Welcher Stand geladen ist: Beschriftung und Commit (7 Zeichen). Leer bei einer freien Umgebung; Container anderer
 * Projekte liefert der Server ohne Inhalt (Mandantentrennung).
 */
export function slotLoadedText(slot: Pick<ReviewSlot, 'status' | 'projectSlug' | 'label' | 'commit'>): string {
  if (slot.status === 'idle') return 'kein Stand geladen';
  if (!slot.projectSlug) return 'belegt von einem anderen Projekt';
  const label = slot.label?.trim() || 'Stand';
  return slot.commit ? `${label} · ${slot.commit.slice(0, 7)}` : `${label} · Stand wird beim Start bestimmt`;
}

/** Eintrag im Dropdown: „Umgebung 2 – Review läuft · dieser Auftrag“. */
export function slotOptionText(slot: ReviewSlot, orderId: string): string {
  const own = showsOrder(slot, orderId) ? ' · dieser Auftrag' : '';
  return `Umgebung ${slot.slot} – ${slotStatusText(slot)}${own}`;
}

/** Vorauswahl: die Umgebung mit diesem Auftrag, sonst eine freie, sonst die erste freigegebene. */
export function defaultSlot(slots: ReviewSlot[], orderId: string): number | null {
  const enabled = slots.filter((slot) => slot.enabled);
  return (
    enabled.find((slot) => showsOrder(slot, orderId))?.slot ??
    enabled.find((slot) => slot.status === 'idle')?.slot ??
    enabled[0]?.slot ??
    null
  );
}

/** Text des Start-Knopfs: neu laden, wenn die Umgebung den Auftrag schon zeigt. */
export function spawnLabel(slot: ReviewSlot | null, orderId: string): string {
  if (!slot) return '▶ Auftrag laden';
  if (showsOrder(slot, orderId)) return slot.status === 'failed' ? '↻ Erneut starten' : '↻ Neu laden';
  return slot.status === 'idle' ? '▶ Auftrag laden' : '▶ Auftrag laden (ersetzt den Stand)';
}
