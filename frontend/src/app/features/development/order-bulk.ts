import type { DevelopmentItem } from '../../core/models.js';
import { DEVELOPMENT_STATUS } from '../../core/models.js';
import { canRetryDevelopment } from '../../../../../src/core/development-transitions.js';

/** Wie die Server-Route /retry: blockiert, abgelehnt oder aus dem Sprint genommen – nie Express-Anfragen. */
export function canRetry(item: DevelopmentItem): boolean {
  return canRetryDevelopment(item);
}

/** Sammelaktionen gelten nur für offene Aufträge: Erledigte und Express-Anfragen bleiben ohne Häkchen. */
export function bulkSelectable(item: DevelopmentItem): boolean {
  return item.kind !== 'express' && item.status !== DEVELOPMENT_STATUS.done;
}
