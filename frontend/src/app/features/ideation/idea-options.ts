import type { ConfirmOptions } from '../../core/confirm.service.js';
import type { DevelopmentItem, Idea } from '../../core/models.js';
import { DEVELOPMENT_STATUS, IDEATION_STATUS } from '../../core/models.js';
import { isFinished } from '../../shared/labels.js';

export const IDEA_STATUSES: readonly string[] = [
  IDEATION_STATUS.idea,
  IDEATION_STATUS.considering,
  IDEATION_STATUS.review,
  IDEATION_STATUS.requested,
  IDEATION_STATUS.drafting,
  IDEATION_STATUS.accepted,
  'implemented',
  IDEATION_STATUS.rejected,
];
export const IDEA_SELECTABLE_STATUSES: readonly string[] = [
  IDEATION_STATUS.idea,
  IDEATION_STATUS.considering,
  IDEATION_STATUS.review,
];
/** Bearbeitbar wie auf dem Server: nicht während der Auftragsautor schreibt und nicht nach der Annahme. */
export const IDEA_EDITABLE_STATUSES: readonly string[] = [...IDEA_SELECTABLE_STATUSES, IDEATION_STATUS.rejected];
/** Noch nicht abgeschlossene Ideen: weder angenommen (bzw. umgesetzt) noch abgelehnt. */
export const OPEN_IDEA_STATUSES: readonly string[] = [
  IDEATION_STATUS.idea,
  IDEATION_STATUS.considering,
  IDEATION_STATUS.review,
  IDEATION_STATUS.requested,
  IDEATION_STATUS.drafting,
];

export function isOpenIdea(idea: Pick<Idea, 'status'>): boolean {
  return OPEN_IDEA_STATUSES.includes(idea.status);
}
export { MAX_IMAGE_BYTES } from '../../shared/image-upload.js';

/** Anzeigestatus: Eine angenommene Idee gilt als umgesetzt, sobald ihr Auftrag erledigt ist. */
export function ideaDisplayStatus(idea: Idea, order: DevelopmentItem | null | undefined): string {
  return idea.status === IDEATION_STATUS.accepted && order?.status === DEVELOPMENT_STATUS.done
    ? 'implemented'
    : idea.status;
}

/**
 * Einordnung einer Idee – gleich für Ideenseite und Dashboard:
 * offen, in Umsetzung (angenommen mit vorhandenem, nicht abgeschlossenem Auftrag),
 * umgesetzt (Auftrag erledigt) oder verworfen (abgelehnt bzw. angenommen ohne laufenden Auftrag).
 */
export type IdeaPhase = 'open' | 'in_progress' | 'implemented' | 'discarded';

export function ideaPhase(
  idea: Pick<Idea, 'status'>,
  order: Pick<DevelopmentItem, 'status'> | null | undefined,
): IdeaPhase {
  if (isOpenIdea(idea)) return 'open';
  if (idea.status === 'implemented') return 'implemented';
  if (idea.status === IDEATION_STATUS.accepted && order) {
    if (order.status === DEVELOPMENT_STATUS.done) return 'implemented';
    if (!isFinished(order.status)) return 'in_progress';
  }
  return 'discarded';
}

const SOURCE_LABELS: Record<string, string> = {
  human: 'Mensch',
  visionary: 'Visionär',
  routine: 'Routine',
  production: 'Produktion',
  github: 'GitHub',
};

/** Herkunftswerte wie `IDEA_SOURCES` auf dem Server, in der Reihenfolge des Filters. */
export const IDEA_SOURCES = Object.keys(SOURCE_LABELS);

/** Bezeichnung der Herkunft einer Idee (ältere Ideen ohne Angabe gelten als von Hand erfasst). */
export function sourceLabel(source: string | null | undefined): string {
  return SOURCE_LABELS[source ?? 'human'] ?? source ?? 'Mensch';
}

/** Feste Werte des Herkunft-Filters („Alle“ ergänzt die Tabelle) – gleich benannt wie Spalte und Badge. */
export const SOURCE_FILTER_OPTIONS: readonly string[] = IDEA_SOURCES.map(sourceLabel);

/** Feld „Richtung“ für den Visionär: gleich in der Ideation und im Aktionsmenü des Assistenten. */
export const VISIONARY_DIRECTION = {
  commentLabel: 'Richtung (optional)',
  commentPlaceholder: 'z. B. Fokus auf Testabdeckung im Backend oder Onboarding neuer Nutzer',
  commentHint: 'Der Visionär berücksichtigt diese Richtung bei seinen Vorschlägen.',
} satisfies Partial<ConfirmOptions>;

/** Dialog vor „Ideen vorschlagen lassen“: leere Richtung = Lauf ohne Vorgabe, Abbrechen = kein Lauf. */
export const VISIONARY_CONFIRM: ConfirmOptions = {
  title: 'Ideen vorschlagen lassen',
  message:
    'Der Visionär liest das Projekt (nur lesend) und schlägt begründete Erweiterungsideen vor. Du kannst ihm eine Richtung vorgeben.',
  confirmLabel: 'Ideen vorschlagen lassen',
  ...VISIONARY_DIRECTION,
};
