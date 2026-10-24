import type { AcceptanceCheck, DevelopmentItem } from '../core/models.js';
import { isFinished, statusLabel } from './labels.js';
import { type AttentionCard, attentionCard } from './attention-card.js';
import { failureParts, orderGuide, type FailureParts, type OrderGuide } from './order-problem.js';

export interface AttentionReason {
  label: string;
  tone: 'error' | 'warn' | 'info';
}

/** Ein Auftrag auf der Seite „Aktionen“: warum er wartet und was zu tun ist. */
export interface AttentionEntry {
  item: DevelopmentItem;
  reasons: AttentionReason[];
  /** Gründe ohne die Angabe, die das Status-Etikett schon zeigt. */
  badges: AttentionReason[];
  /** Punkte, die nur ein Mensch prüfen kann. */
  checks: AcceptanceCheck[];
  guide: OrderGuide | null;
  failure: FailureParts | null;
  /** Ein Grund und ein nächster Schritt für die Karte unter „Aktionen“. */
  card: AttentionCard;
}

/**
 * Aufträge, die eine Entscheidung brauchen: wartet auf Freigabe, abgelehnt, blockiert bzw. mit offener Aktion,
 * aus dem Sprint genommen oder mit Punkten, die nur ein Mensch prüfen kann.
 */
export function orderAttention(development: DevelopmentItem[], acceptance: AcceptanceCheck[]): AttentionEntry[] {
  const manual = new Map<string, AcceptanceCheck[]>();
  for (const check of acceptance) {
    if (check.status === 'manual') manual.set(check.developmentId, [...(manual.get(check.developmentId) ?? []), check]);
  }
  return development
    .map((item) => {
      const reasons: AttentionReason[] = [];
      // Wartet der Auftrag auf einen Menschen, ist er nicht gescheitert, sondern braucht eine Aktion.
      // Schon freigegeben: wartet nur noch auf den Merge – steht unter „Läuft gerade“, nicht mehr bei dir.
      if (item.status === 'approval' && !item.reviewApprovedAt)
        reasons.push({ label: 'Wartet auf Freigabe', tone: 'info' });
      else if (item.status === 'rejected')
        reasons.push({ label: 'Abgelehnt – verstösst gegen Projektregel', tone: 'error' });
      else if (item.status === 'blocked' || (item.actionTodo && !isFinished(item.status)))
        reasons.push({ label: 'Aktion notwendig', tone: 'warn' });
      if (item.removedFromSprintAt && !isFinished(item.status)) {
        reasons.push({ label: `Aus Sprint „${item.removedFromSprint ?? '?'}“ genommen`, tone: 'info' });
      }
      const checks = manual.get(item.id) ?? [];
      if (checks.length && !item.actionTodo) {
        const open = checks.length;
        reasons.push({ label: `${open} Punkt${open === 1 ? '' : 'e'} von dir zu prüfen`, tone: 'warn' });
      }
      // Das Etikett neben dem Titel nennt den Status schon; dieselbe Angabe nicht noch einmal darunter zeigen.
      const badges = reasons.filter((reason) => reason.label !== statusLabel(item.status));
      return {
        item,
        reasons,
        badges,
        checks: item.actionTodo ? [] : checks,
        guide: orderGuide(item),
        failure: item.failure ? failureParts(item.failure) : null,
        card: attentionCard(item, item.actionTodo ? 0 : checks.length),
      };
    })
    .filter((entry) => entry.reasons.length);
}
