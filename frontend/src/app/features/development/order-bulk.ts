import type { DevelopmentItem } from '../../core/models.js';

/** Wie die Server-Route /retry: blockiert, abgelehnt oder aus dem Sprint genommen – nie Express-Anfragen. */
export function canRetry(item: DevelopmentItem): boolean {
  if (item.kind === 'express') return false;
  if (item.status === 'blocked' || item.status === 'rejected') return true;
  return !!item.removedFromSprintAt && (item.status === 'backlog' || item.status === 'planned');
}

/** Sammelaktionen gelten nur für offene Aufträge: Erledigte und Express-Anfragen bleiben ohne Häkchen. */
export function bulkSelectable(item: DevelopmentItem): boolean {
  return item.kind !== 'express' && item.status !== 'done';
}
