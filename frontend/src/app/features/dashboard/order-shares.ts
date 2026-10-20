import type { DevelopmentStatus, Sprint } from '../../core/models.js';

/** Reihenfolge der Auftrags-Status im Dashboard; enthält jeden Status aus `DevelopmentStatus`. */
export const ORDER_STATUSES = [
  'done',
  'in_progress',
  'approval',
  'planned',
  'backlog',
  'rejected',
  'blocked',
] as const satisfies readonly DevelopmentStatus[];

/** Farbton je Status, überall gleich: grün erledigt, blau in Arbeit, orange wartet/Warnung, rot Fehler. */
export const ORDER_TONES: Record<DevelopmentStatus, string> = {
  backlog: 'neutral',
  planned: 'info',
  in_progress: 'active',
  approval: 'wait',
  blocked: 'warn',
  done: 'ok',
  rejected: 'neutral',
};

/** Freigabe, abgelehnt und blockiert stehen nicht in der Auftragsliste, sondern unter „Aktionen“. */
export function opensActions(status: DevelopmentStatus): boolean {
  return status === 'approval' || status === 'rejected' || status === 'blocked';
}

/**
 * Neueste Sprints zuerst: nach Start- (ersatzweise End-)Datum absteigend; Sprints ohne Datum sind noch
 * nicht terminiert und gelten als die neuesten. Die API sortiert nach Status und darin aufsteigend.
 */
export function newestSprints<T extends Pick<Sprint, 'startDate' | 'endDate'>>(sprints: T[], limit: number): T[] {
  const key = (sprint: T): string => sprint.startDate ?? sprint.endDate ?? '';
  return [...sprints]
    .sort((left, right) => {
      const a = key(left);
      const b = key(right);
      if (!a || !b) return a ? 1 : b ? -1 : 0;
      return b.localeCompare(a);
    })
    .slice(0, limit);
}
