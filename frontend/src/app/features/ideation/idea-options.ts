import type { DevelopmentItem, Idea } from '../../core/models.js';

export const IDEA_STATUSES = [
  'idea',
  'considering',
  'review',
  'requested',
  'drafting',
  'accepted',
  'implemented',
  'rejected',
];
export const IDEA_SELECTABLE_STATUSES = ['idea', 'considering', 'review'];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const SOURCE_LABELS: Record<string, string> = {
  human: 'Mensch',
  visionary: 'Visionär',
  routine: 'Routine',
  production: 'Produktion',
  github: 'GitHub',
};

/** Bezeichnung der Herkunft einer Idee (ältere Ideen ohne Angabe gelten als von Hand erfasst). */
export function sourceLabel(source: string | null | undefined): string {
  return SOURCE_LABELS[source ?? 'human'] ?? source ?? 'Mensch';
}

/** Anzeigestatus: Eine angenommene Idee gilt als umgesetzt, sobald ihr Auftrag erledigt ist. */
export function ideaDisplayStatus(idea: Idea, order: DevelopmentItem | null | undefined): string {
  return idea.status === 'accepted' && order?.status === 'done' ? 'implemented' : idea.status;
}
