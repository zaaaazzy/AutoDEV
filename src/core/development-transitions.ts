// Gemeinsam für Server (PATCH /development/:id) und Oberfläche (Status- und Sprint-Auswahl).
// Bewusst ohne Importe: die Datei wird ins Frontend-Image kopiert (deploy/frontend/Dockerfile).

/**
 * Erlaubte manuelle Statuswechsel eines Auftrags. `in_progress`, `approval` und `done` setzt nur der Worker
 * (Agent-Lauf, Tester, Review, Merge); laufende oder fertige Aufträge ändert die Oberfläche über eigene Routen
 * (Erneut versuchen, Freigeben, Ablehnen, aus dem Sprint nehmen).
 */
export const MANUAL_DEVELOPMENT_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  backlog: ['planned', 'rejected'],
  planned: ['backlog', 'rejected'],
  blocked: ['planned', 'backlog', 'rejected'],
  rejected: ['backlog', 'planned'],
};

/** Darf der Status von Hand von `from` auf `to` wechseln? Der gleiche Status gilt als erlaubt (keine Änderung). */
export function canSetDevelopmentStatus(from: string, to: string): boolean {
  return from === to || (MANUAL_DEVELOPMENT_TRANSITIONS[from]?.includes(to) ?? false);
}

/**
 * In Arbeit, in Freigabe oder erledigt hängt ein Auftrag fest an seinem Sprint (Sprint-Branch, Fortschritt, Bericht):
 * weder Sprint-Auswahl (PATCH) noch „Aus dem Sprint nehmen“ dürfen ihn umhängen.
 */
export const SPRINT_LOCKED_DEVELOPMENT_STATUSES: readonly string[] = ['in_progress', 'approval', 'done'];

export function isSprintLockedDevelopmentStatus(status: string): boolean {
  return SPRINT_LOCKED_DEVELOPMENT_STATUSES.includes(status);
}

/** Aufträge lassen sich nur Sprints zuordnen, die noch laufen können (nicht im Review, nicht abgeschlossen). */
export const ASSIGNABLE_SPRINT_STATUSES: readonly string[] = ['planned', 'active'];

export function isAssignableSprintStatus(status: string): boolean {
  return ASSIGNABLE_SPRINT_STATUSES.includes(status);
}
