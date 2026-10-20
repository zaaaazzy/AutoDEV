import type { DevelopmentItem, ReviewSlot, SprintCommit } from '../../core/models.js';
import { isFinished } from '../../shared/labels.js';

const STATUS_TEXT: Record<ReviewSlot['status'], string> = {
  idle: 'frei',
  requested: 'Stand wird ausgecheckt …',
  starting: 'Container startet (Abhängigkeiten, Datenbank-Kopie) …',
  running: 'Review läuft',
  failed: 'Fehler: Start fehlgeschlagen',
  stopping: 'wird beendet …',
};

/** Statustext eines Review-Containers; bei einem Fehler mit der ersten Zeile der Meldung des Servers. */
export function reviewStatusText(slot: Pick<ReviewSlot, 'status' | 'message'>): string {
  if (slot.status === 'failed') {
    const line = slot.message?.trim().split('\n')[0]?.trim();
    if (line) return `Fehler: ${line.length > 160 ? `${line.slice(0, 159)}…` : line}`;
  }
  return STATUS_TEXT[slot.status];
}

/** Container arbeitet noch am Start: Ladeanimation zeigen. */
export function reviewStarting(slot: Pick<ReviewSlot, 'status'> | null | undefined): boolean {
  return slot?.status === 'requested' || slot?.status === 'starting';
}

/**
 * Container, der zu dieser Auswahl gehört: zuerst der hier gestartete, dann einer mit einem Stand des Sprints,
 * sonst ein laufender, von Hand gestarteter Container des Projekts.
 */
export function sprintReviewSlot(
  slots: ReviewSlot[],
  project: string,
  commits: Pick<SprintCommit, 'hash'>[],
  pending: number | null,
): ReviewSlot | null {
  const hashes = new Set(commits.map((commit) => commit.hash));
  return (
    slots.find((slot) => slot.slot === pending && slot.projectSlug === project) ??
    slots.find((slot) => slot.projectSlug === project && slot.commit && hashes.has(slot.commit)) ??
    slots.find((slot) => slot.projectSlug === project && slot.status !== 'idle' && slot.kind === 'manual') ??
    null
  );
}

/** Eintrag der Stand-Auswahl: „◌ “ markiert einen noch nicht gemergten Stand. */
export function commitOptionLabel(commit: SprintCommit, date: string): string {
  return `${commit.merged ? '' : '◌ '}${commit.subject} · ${commit.hash.slice(0, 7)} · ${date}`;
}

/** Nächste offene Aufträge eines Sprints in der Kanban-Reihenfolge (Vorschau in der Kopfzeile). */
export function nextOpenOrders(items: DevelopmentItem[], sprintId: string, limit = 5): DevelopmentItem[] {
  return items
    .filter((item) => item.sprintId === sprintId && !isFinished(item.status))
    .sort(
      (left, right) =>
        Number(right.status === 'in_progress') - Number(left.status === 'in_progress') ||
        (left.sprintRank ?? Number.MAX_SAFE_INTEGER) - (right.sprintRank ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(0, limit);
}
