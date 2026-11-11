import type { DevelopmentItem } from '../../core/models.js';

/** Reiter „Ansicht“ bei Frontend- und Fullstack-Aufträgen (oder wenn es schon Befunde bzw. eine Freigabe gibt). */
export function needsVisual(
  item: Pick<DevelopmentItem, 'category' | 'visualApprovedAt'>,
  visualChecks: number,
): boolean {
  return (
    item.category === 'frontend' || item.category === 'fullstack' || Boolean(item.visualApprovedAt) || visualChecks > 0
  );
}
