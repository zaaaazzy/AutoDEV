import type { Agent, DevelopmentItem, DevelopmentStatus, Sprint } from '../../core/models.js';
import { isFinished } from '../../shared/labels.js';
import { DEVELOPMENT_STATUS } from '../../core/models.js';

/** Wert der Spalte „Agent“ in der Auftragsliste für Aufträge ohne (bekannten) Agent. */
export const NO_AGENT = 'Ohne Agent';

/** Name des zugeordneten Agents, sonst „Ohne Agent“ (auch wenn der Agent nicht mehr existiert). */
export function orderAgentName(
  item: Pick<DevelopmentItem, 'agentId'>,
  agents: readonly Pick<Agent, 'id' | 'name'>[],
): string {
  return agents.find((agent) => agent.id === item.agentId)?.name ?? NO_AGENT;
}

export interface AgentWorkload {
  /** Agent-ID, `null` für „Ohne Agent“. */
  id: string | null;
  label: string;
  value: number;
}

/**
 * Offene Aufträge (nicht erledigt/abgelehnt) je Agent des Projekts, zuletzt „Ohne Agent“. Die Summe aller
 * Werte ist die Zahl der offenen Aufträge; Agents ohne offene Aufträge erscheinen mit 0.
 */
export function agentWorkload(
  items: readonly Pick<DevelopmentItem, 'agentId' | 'status'>[],
  agents: readonly Pick<Agent, 'id' | 'name'>[],
): AgentWorkload[] {
  const open = items.filter((item) => !isFinished(item.status));
  const rows = agents.map((agent) => ({
    id: agent.id,
    label: agent.name,
    value: open.filter((item) => item.agentId === agent.id).length,
  }));
  const assigned = rows.reduce((sum, row) => sum + row.value, 0);
  return [...rows, { id: null, label: NO_AGENT, value: open.length - assigned }];
}

/** Reihenfolge der Auftrags-Status im Dashboard; enthält jeden Status aus `DevelopmentStatus`. */
export const ORDER_STATUSES = [
  DEVELOPMENT_STATUS.done,
  DEVELOPMENT_STATUS.inProgress,
  DEVELOPMENT_STATUS.approval,
  DEVELOPMENT_STATUS.planned,
  DEVELOPMENT_STATUS.backlog,
  DEVELOPMENT_STATUS.rejected,
  DEVELOPMENT_STATUS.blocked,
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
