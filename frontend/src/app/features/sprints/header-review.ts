import type { ReviewCommit, ReviewSlot } from '../../core/models.js';

/** Gruppe der Auswahl: ein Sprint mit seinen Ständen (neueste zuerst). */
export interface ReviewCommitGroup {
  sprintId: string;
  sprintName: string;
  commits: ReviewCommit[];
}

/** Stände nach Sprint gruppieren, in der Reihenfolge des Servers (laufender Sprint zuerst). */
export function groupReviewCommits(commits: ReviewCommit[]): ReviewCommitGroup[] {
  const groups: ReviewCommitGroup[] = [];
  for (const commit of commits) {
    const group = groups.find((entry) => entry.sprintId === commit.sprintId);
    if (group) group.commits.push(commit);
    else groups.push({ sprintId: commit.sprintId, sprintName: commit.sprintName, commits: [commit] });
  }
  return groups;
}

/** Kurzer Hinweis zum Stand: im Sprint, wartet auf Freigabe oder eigener Auftrags-Branch. */
export function reviewCommitBadge(commit: Pick<ReviewCommit, 'merged' | 'orderStatus'>): {
  text: string;
  tone: 'merged' | 'approval' | 'branch';
} {
  if (commit.merged) return { text: 'im Sprint', tone: 'merged' };
  if (commit.orderStatus === 'approval') return { text: 'wartet auf Freigabe', tone: 'approval' };
  return { text: 'eigener Branch', tone: 'branch' };
}

/**
 * Container, den die Kopfzeile zeigt: zuerst der hier gestartete, dann ein manuell gestarteter des Projekts, sonst
 * irgendein laufender oder startender des Projekts (z. B. die Vorschau einer Freigabe).
 */
export function headerReviewSlot(slots: ReviewSlot[], project: string, pending: number | null): ReviewSlot | null {
  const mine = slots.filter((slot) => slot.projectSlug === project && slot.status !== 'idle');
  return (
    mine.find((slot) => slot.slot === pending) ??
    mine.find((slot) => slot.kind === 'manual') ??
    mine.find((slot) => slot.status !== 'stopping') ??
    null
  );
}

/** Adresse ohne Protokoll für den Link („localhost:4202“). */
export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
