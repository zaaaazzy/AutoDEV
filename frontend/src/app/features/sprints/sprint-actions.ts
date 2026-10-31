import type { WritableSignal } from '@angular/core';
import {
  canActivateSprint,
  canChangeSprintStatus,
  canDeleteSprint,
  completeSprintConflict,
  hasOtherActiveSprint,
  ONE_ACTIVE_SPRINT_MESSAGE,
} from '../../../../../src/core/sprint-rules.js';

type SprintRef = { id: string; status: string; gitSync?: string | null };
type ItemRef = { sprintId?: string | null; status: string };

/** Welche Knöpfe das Sprint-Detail zeigt: Regeln des Servers (sprint-rules) und Rolle der Route. */
export interface SprintButtons {
  edit: boolean;
  start: boolean;
  pause: boolean;
  resume: boolean;
  /** „Live schalten“ sichtbar; liveBlocked nennt den Grund, warum der Server noch 409 liefern würde. */
  live: boolean;
  liveBlocked: string | null;
  reopen: boolean;
  /** „Sprint starten“/„Wieder öffnen“ sichtbar, aber gesperrt, solange ein anderer Sprint aktiv ist (Server: 409). */
  activateBlocked: string | null;
  cancel: boolean;
  replan: boolean;
  remove: boolean;
}

/**
 * PATCH und DELETE /sprints/:id brauchen „Planung“, Pausieren/Fortsetzen „Ausführen“ (access in sprints.ts).
 * `sprints` sind die Sprints desselben Projekts, `items` dessen Aufträge.
 */
export function sprintButtons(
  sprint: SprintRef & { pausedAt?: string | null },
  sprints: readonly SprintRef[],
  items: readonly ItemRef[],
  can: (role: 'plan' | 'run') => boolean,
): SprintButtons {
  const plan = can('plan');
  const run = can('run');
  const mine = (status: string) => items.filter((item) => item.sprintId === sprint.id && item.status === status).length;
  const live = plan && canChangeSprintStatus(sprint.status, 'completed');
  // Ohne den anderen aktiven Sprint erlaubt: Knopf zeigen, Sperre über activateBlocked.
  const activatable =
    plan &&
    canActivateSprint(
      sprint,
      sprints.filter((other) => other.status !== 'active'),
    );
  return {
    edit: plan,
    start: activatable && sprint.status === 'planned',
    pause: run && sprint.status === 'active' && !sprint.pausedAt,
    resume: run && sprint.status === 'active' && !!sprint.pausedAt,
    live,
    liveBlocked: live ? completeSprintConflict(mine('in_progress'), mine('approval')) : null,
    reopen: activatable && sprint.status === 'completed',
    activateBlocked: activatable && hasOtherActiveSprint(sprint, sprints) ? ONE_ACTIVE_SPRINT_MESSAGE : null,
    cancel: plan && canChangeSprintStatus(sprint.status, 'cancelled'),
    replan: plan && sprint.status === 'cancelled' && canChangeSprintStatus(sprint.status, 'planned'),
    remove: plan && canDeleteSprint(sprint, items),
  };
}

/**
 * Führt `action` nur aus, wenn gerade keine andere läuft; `flag` ist ab dem ersten Klick gesetzt (auch während der
 * Rückfrage) und wird im finally zurückgesetzt, damit die Knöpfe nach einem Fehler wieder gehen.
 */
export async function exclusive(flag: WritableSignal<boolean>, action: () => Promise<unknown>): Promise<void> {
  if (flag()) return;
  flag.set(true);
  try {
    await action();
  } finally {
    flag.set(false);
  }
}
