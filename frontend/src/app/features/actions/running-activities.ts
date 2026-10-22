import type { DevelopmentItem, ReviewSlot, WorkerStatus } from '../../core/models.js';

/** Eine laufende Tätigkeit unter „Aktionen → Läuft gerade“. */
export interface RunningActivity {
  /** git = Merge/Git-Lösung, agent = Agent arbeitet, user = von dir angestossen (Review-Container). */
  kind: 'git' | 'agent' | 'user';
  label: string;
  detail: string;
}

export interface ActivityInput {
  development: Pick<DevelopmentItem, 'id' | 'title' | 'status' | 'reviewApprovedAt'>[];
  agents: WorkerStatus['agents'];
  /** Laufende Git-Lösung (Zwischenstand sichern, zurück auf main, main abgleichen) als Text, sonst null. */
  gitFix: string | null;
  slots: Pick<ReviewSlot, 'slot' | 'status' | 'label' | 'projectSlug'>[];
  project: string;
}

/**
 * Was gerade läuft, ausser Tests und der Git-Sicherung des Sprints (die zeigt die Fortschrittskarte darüber):
 * freigegebene Aufträge, die auf den Merge warten, Git-Lösungen, arbeitende Agents und startende Review-Container.
 */
export function runningActivities(input: ActivityInput): RunningActivity[] {
  const activities: RunningActivity[] = [];
  for (const item of input.development) {
    if (item.status === 'approval' && item.reviewApprovedAt) {
      activities.push({
        kind: 'git',
        label: 'Freigegeben – wird gemergt',
        detail: `${item.title} · zwischen zwei Aufträgen, danach baut die Vorschau neu`,
      });
    }
  }
  if (input.gitFix) activities.push({ kind: 'git', label: 'Git-Lösung läuft', detail: input.gitFix });
  for (const agent of input.agents) {
    if (!agent.active) continue;
    activities.push({ kind: 'agent', label: `${agent.name} arbeitet`, detail: agent.orderTitle ?? '' });
  }
  for (const slot of input.slots) {
    if (slot.projectSlug !== input.project) continue;
    if (slot.status === 'requested' || slot.status === 'starting') {
      activities.push({
        kind: 'user',
        label: `Review ${slot.slot} startet`,
        detail: `${slot.label ?? 'Stand'} · Abhängigkeiten und Datenbank-Kopie, dauert meist 1–2 Minuten`,
      });
    } else if (slot.status === 'stopping') {
      activities.push({ kind: 'user', label: `Review ${slot.slot} wird beendet`, detail: slot.label ?? '' });
    }
  }
  return activities;
}
