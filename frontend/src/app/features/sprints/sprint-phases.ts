/** Einordnung der Aufträge eines Sprints für die Liste auf der Sprint-Seite (Gruppen wie die Status-Etiketten). */

export type SprintPhase = 'running' | 'approval' | 'blocked' | 'planned' | 'done' | 'rejected';

/** Reihenfolge der Gruppen: was gerade läuft oder auf dich wartet zuerst, Erledigtes am Ende. */
export const SPRINT_PHASES: readonly { id: SprintPhase; label: string }[] = [
  { id: 'running', label: 'In Arbeit' },
  { id: 'approval', label: 'Wartet auf Freigabe' },
  { id: 'blocked', label: 'Aktion notwendig' },
  { id: 'planned', label: 'Geplant – Reihenfolge = Abarbeitung' },
  { id: 'done', label: 'Erledigt' },
  { id: 'rejected', label: 'Abgelehnt' },
];

interface SprintOrder {
  id: string;
  status: string;
  priority: 'low' | 'medium' | 'high';
  sprintRank?: number | null;
}

const PRIORITY = { high: 0, medium: 1, low: 2 } as const;

export function sprintPhase(order: Pick<SprintOrder, 'status'>): SprintPhase {
  switch (order.status) {
    case 'in_progress':
      return 'running';
    case 'approval':
    case 'blocked':
    case 'done':
    case 'rejected':
      return order.status;
    default:
      return 'planned';
  }
}

export function phaseRank(phase: SprintPhase): number {
  return SPRINT_PHASES.findIndex((entry) => entry.id === phase);
}

export function phaseLabel(phase: SprintPhase): string {
  return SPRINT_PHASES[phaseRank(phase)]!.label;
}

/** Wie die Agents abarbeiten: nach Sprint-Rang, ohne Rang nach Priorität. */
export function byRank<T extends SprintOrder>(orders: readonly T[]): T[] {
  return [...orders].sort(
    (a, b) => (a.sprintRank ?? 1e9) - (b.sprintRank ?? 1e9) || PRIORITY[a.priority] - PRIORITY[b.priority],
  );
}

/** Alle Aufträge des Sprints: erst nach Phase, innerhalb der Phase in Abarbeitungs-Reihenfolge. */
export function orderSprint<T extends SprintOrder>(orders: readonly T[]): T[] {
  return byRank(orders).sort((a, b) => phaseRank(sprintPhase(a)) - phaseRank(sprintPhase(b)));
}

/** Einen Auftrag in der Liste um `delta` Plätze verschieben; am Rand bleibt alles, wie es ist. */
export function moveId(ids: readonly string[], id: string, delta: number): string[] {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return [...ids];
  const next = [...ids];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}
