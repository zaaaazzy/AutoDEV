import { awaitsApproval } from './sprint-actions.js';

type RequestRef = { sprintId?: string | null; status: string; reviewApprovedAt?: string | null };

/** Vermerk je Zeile: Abgenommene bleiben sichtbar, bis der Worker sie gemergt hat. */
export function requestState(item: RequestRef): string {
  return awaitsApproval(item) ? 'Wartet auf Abnahme' : 'Abgenommen – wird gemergt';
}

/** Umsetzungen des Sprints im Status Freigabe: wartende zuerst, danach die abgenommenen. */
export function sprintRequests<T extends RequestRef>(items: readonly T[], sprintId: string): T[] {
  const mine = items.filter((item) => item.sprintId === sprintId && item.status === 'approval');
  return [...mine.filter(awaitsApproval), ...mine.filter((item) => !awaitsApproval(item))];
}
