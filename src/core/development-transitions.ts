// Gemeinsam für Server (PATCH /development/:id) und Oberfläche (Status- und Sprint-Auswahl).
// Importiert nur status.ts: beide Dateien werden ins Frontend-Image kopiert (deploy/frontend/Dockerfile).
import { DEVELOPMENT_STATUS } from './status.js';

/**
 * Erlaubte manuelle Statuswechsel eines Auftrags. `in_progress`, `approval` und `done` setzt nur der Worker
 * (Agent-Lauf, Tester, Review, Merge); laufende oder fertige Aufträge ändert die Oberfläche über eigene Routen
 * (Erneut versuchen, Freigeben, Ablehnen, aus dem Sprint nehmen).
 */
export const MANUAL_DEVELOPMENT_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  backlog: [DEVELOPMENT_STATUS.planned, DEVELOPMENT_STATUS.rejected],
  planned: [DEVELOPMENT_STATUS.backlog, DEVELOPMENT_STATUS.rejected],
  blocked: [DEVELOPMENT_STATUS.planned, DEVELOPMENT_STATUS.backlog, DEVELOPMENT_STATUS.rejected],
  rejected: [DEVELOPMENT_STATUS.backlog, DEVELOPMENT_STATUS.planned],
};

/** Darf der Status von Hand von `from` auf `to` wechseln? Der gleiche Status gilt als erlaubt (keine Änderung). */
export function canSetDevelopmentStatus(from: string, to: string): boolean {
  return from === to || (MANUAL_DEVELOPMENT_TRANSITIONS[from]?.includes(to) ?? false);
}

/**
 * In Arbeit, in Freigabe oder erledigt hängt ein Auftrag fest an seinem Sprint (Sprint-Branch, Fortschritt, Bericht):
 * die Sprint-Auswahl (PATCH) darf ihn nicht umhängen.
 */
export const SPRINT_LOCKED_DEVELOPMENT_STATUSES: readonly string[] = [
  DEVELOPMENT_STATUS.inProgress,
  DEVELOPMENT_STATUS.approval,
  DEVELOPMENT_STATUS.done,
];

export function isSprintLockedDevelopmentStatus(status: string): boolean {
  return SPRINT_LOCKED_DEVELOPMENT_STATUSES.includes(status);
}

/** „Erneut versuchen“ (/retry) geht immer aus blockiert und abgelehnt. */
export const RETRYABLE_DEVELOPMENT_STATUSES: readonly string[] = ['blocked', 'rejected'];

/**
 * Aus einem Sprint genommen (Vermerk removed_from_sprint_at) lässt sich ein Auftrag erst wieder einplanen, wenn er
 * wieder offen ist. Ein laufender Auftrag kommt erst nach dem Ende seines Agent-Laufs ins Backlog (settleItem).
 */
export const REPLANNABLE_DEVELOPMENT_STATUSES: readonly string[] = [
  DEVELOPMENT_STATUS.backlog,
  DEVELOPMENT_STATUS.planned,
];

type RetrySource = { status: string; kind?: string | null; removedFromSprintAt?: string | Date | null };

/** Bietet die Oberfläche „Erneut versuchen“/„Wieder einplanen“ an? Genau die Bedingung der Route /retry. */
export function canRetryDevelopment(item: RetrySource): boolean {
  if (item.kind === 'express') return false;
  if (RETRYABLE_DEVELOPMENT_STATUSES.includes(item.status)) return true;
  return !!item.removedFromSprintAt && REPLANNABLE_DEVELOPMENT_STATUSES.includes(item.status);
}

/** „Aufträge hinzufügen“ eines Sprints (Route take-into-sprint): offene oder blockierte Aufträge ohne Sprint. */
export const SPRINT_POOL_DEVELOPMENT_STATUSES: readonly string[] = [
  DEVELOPMENT_STATUS.backlog,
  DEVELOPMENT_STATUS.planned,
  DEVELOPMENT_STATUS.blocked,
];

export function canTakeIntoSprint(item: RetrySource & { sprintId?: string | null }): boolean {
  return !item.sprintId && item.kind !== 'express' && SPRINT_POOL_DEVELOPMENT_STATUSES.includes(item.status);
}

/**
 * „Aus dem Sprint nehmen“: nur offene, geplante oder blockierte Aufträge. In Freigabe oder abgelehnt hängt am Auftrag
 * noch der Review-Branch; ohne Sprint würde „Freigeben“ ihn ohne Sprintbezug mergen.
 */
export const SPRINT_REMOVABLE_DEVELOPMENT_STATUSES: readonly string[] = [
  DEVELOPMENT_STATUS.backlog,
  DEVELOPMENT_STATUS.planned,
  DEVELOPMENT_STATUS.blocked,
];

/** Aufträge lassen sich nur Sprints zuordnen, die noch laufen können (nicht im Review, nicht abgeschlossen). */
export const ASSIGNABLE_SPRINT_STATUSES: readonly string[] = ['planned', 'active'];

export function isAssignableSprintStatus(status: string): boolean {
  return ASSIGNABLE_SPRINT_STATUSES.includes(status);
}
