import type { DevelopmentItem, ReviewSlot } from '../../core/models.js';

/**
 * Gemeinsame Regeln der Review-Boxen eines Auftrags (Freigabe unter „Aufträge“/„Aktionen“ und Abnahme unter
 * „Aktionen“), damit beide denselben Container, dieselben Texte und denselben Start zeigen.
 */

/** Review-Container, der diesen Auftrag zeigt (bzw. für ihn angefordert ist); freie Container zählen nicht. */
export function orderReviewSlot(slots: readonly ReviewSlot[] | null | undefined, orderId: string): ReviewSlot | null {
  return slots?.find((slot) => slot.developmentId === orderId && slot.status !== 'idle') ?? null;
}

/** Freier Container, in dem ein neuer Review starten kann. */
export function freeReviewSlot(slot: Pick<ReviewSlot, 'enabled' | 'status'>): boolean {
  return slot.enabled && slot.status === 'idle';
}

/** Zeile neben dem Statuspunkt; ohne Container oder in Übergängen „Wird gestartet …“. */
export function reviewInstanceLabel(slot: Pick<ReviewSlot, 'slot' | 'status'> | null): string {
  switch (slot?.status) {
    case 'running':
      return `Review ${slot.slot} läuft`;
    case 'starting':
      return `Review ${slot.slot} startet (Abhängigkeiten, Datenbank-Kopie) …`;
    case 'failed':
      return `Review ${slot.slot} konnte nicht starten`;
    default:
      return 'Wird gestartet …';
  }
}

/** Start-Knopf zeigen: noch kein Container für den Auftrag oder sein Start ist gescheitert (dann „neu starten“). */
export function reviewLaunchable(slot: Pick<ReviewSlot, 'status'> | null): boolean {
  return !slot || slot.status === 'failed';
}

export interface ReviewLaunchDeps {
  activeProject: () => string;
  isActive: (slug: string) => boolean;
  showReview: (item: DevelopmentItem) => Promise<unknown>;
  refresh: () => Promise<void>;
}

/**
 * Review-Container für den Auftrag starten und danach den Stand nachladen – aber nur, wenn inzwischen nicht
 * das Projekt gewechselt wurde (sonst landete der Stand des alten Projekts in der Box).
 */
export async function launchOrderReview(deps: ReviewLaunchDeps, item: DevelopmentItem): Promise<void> {
  const slug = deps.activeProject();
  await deps.showReview(item);
  if (deps.isActive(slug)) await deps.refresh();
}
