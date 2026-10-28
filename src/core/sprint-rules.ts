// Gemeinsam für Server (PATCH/DELETE /sprints/:id) und Oberfläche (Knöpfe im Sprint-Detail).
// Bewusst ohne Importe: die Datei wird ins Frontend-Image kopiert (deploy/frontend/Dockerfile).

/**
 * Erlaubte Statuswechsel per PATCH. Review → abgeschlossen übernimmt der Worker (Merge nach grüner CI).
 * Abgeschlossen → aktiv ist „Wieder öffnen“ in der Oberfläche. Abbrechen geht aus Planung und Lauf (cancelSprint);
 * ein abgebrochener Sprint lässt sich nur wieder planen.
 */
export const SPRINT_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  planned: ['active', 'cancelled'],
  active: ['planned', 'completed', 'cancelled'],
  completed: ['active'],
  cancelled: ['planned'],
};

export function canChangeSprintStatus(from: string, to: string): boolean {
  return SPRINT_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Löschen nur aus diesen Status (kein laufender Sprint, kein offener PR im Review). */
export const DELETABLE_SPRINT_STATUSES: readonly string[] = ['planned', 'completed', 'cancelled'];
/** Git-Sicherung ruht: null oder einer dieser Werte. */
export const IDLE_SPRINT_GIT_SYNC: readonly string[] = ['done', 'failed', 'awaiting_merge'];
/** Aufträge, die einen Sprint festhalten: laufend oder in Freigabe (die Freigabe mergt in den Sprint-Branch). */
export const SPRINT_HOLDING_DEVELOPMENT_STATUSES: readonly string[] = ['in_progress', 'approval'];

type SprintRef = { id: string; status: string; gitSync?: string | null };
type ItemRef = { sprintId?: string | null; status: string };

export function isSprintGitIdle(gitSync: string | null | undefined): boolean {
  return gitSync === null || gitSync === undefined || IDLE_SPRINT_GIT_SYNC.includes(gitSync);
}

function count(sprintId: string, items: readonly ItemRef[], status: string): number {
  return items.filter((item) => item.sprintId === sprintId && item.status === status).length;
}

/** Genau die Bedingung von DELETE /sprints/:id. */
export function canDeleteSprint(sprint: SprintRef, items: readonly ItemRef[]): boolean {
  return (
    DELETABLE_SPRINT_STATUSES.includes(sprint.status) &&
    isSprintGitIdle(sprint.gitSync) &&
    !SPRINT_HOLDING_DEVELOPMENT_STATUSES.some((status) => count(sprint.id, items, status) > 0)
  );
}

/** Grund, warum ein Sprint nicht abgeschlossen werden kann; null = Abschluss erlaubt (Statuswechsel separat prüfen). */
export function completeSprintConflict(running: number, waiting: number): string | null {
  if (running > 0) return 'Im Sprint laufen noch Aufträge – erst abwarten oder stoppen, dann abschließen.';
  if (waiting > 0) {
    // Freigaben werden später in den Sprint-Branch gemergt – nach dem Abschluss kämen sie nie mehr in main.
    return `${waiting} Auftrag/Aufträge warten auf die Review-Freigabe oder den Merge danach – erst freigeben bzw. zurückweisen und den Merge abwarten, dann abschliessen.`;
  }
  return null;
}

/** „Live schalten“: aktiver Sprint ohne laufende Aufträge und ohne offene Freigaben. */
export function canCompleteSprint(sprint: SprintRef, items: readonly ItemRef[]): boolean {
  return (
    canChangeSprintStatus(sprint.status, 'completed') &&
    completeSprintConflict(count(sprint.id, items, 'in_progress'), count(sprint.id, items, 'approval')) === null
  );
}

/** Pro Projekt ist höchstens ein Sprint aktiv (Unique-Index); `sprints` sind die Sprints desselben Projekts. */
export function hasOtherActiveSprint(sprint: SprintRef, sprints: readonly SprintRef[]): boolean {
  return sprints.some((other) => other.id !== sprint.id && other.status === 'active');
}

/** „Sprint starten“ bzw. „Wieder öffnen“: erlaubter Wechsel und kein anderer aktiver Sprint. */
export function canActivateSprint(sprint: SprintRef, sprints: readonly SprintRef[]): boolean {
  return (
    sprint.status !== 'active' &&
    canChangeSprintStatus(sprint.status, 'active') &&
    !hasOtherActiveSprint(sprint, sprints)
  );
}
