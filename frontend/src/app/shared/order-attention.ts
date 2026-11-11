import type { AcceptanceCheck, DevelopmentItem, TestEvidence } from '../core/models.js';
import { DEVELOPMENT_STATUS } from '../core/models.js';
import { MANUAL_TODO_PREFIX } from '../../../../src/core/shared-types.js';
import { isFinished, statusLabel } from './labels.js';
import { type AttentionCard, attentionCard } from './attention-card.js';
import { failureParts, orderGuide, type FailureParts, type OrderGuide } from './order-problem.js';

export interface AttentionReason {
  label: string;
  tone: 'error' | 'warn' | 'info';
}

/**
 * Was bei einem Auftrag unter „Aktionen“ als Nächstes zu tun ist – die Spalte „Zu tun“ vor dem Aufklappen.
 * Genau eine Art je Auftrag, in dieser Rangfolge: Rückfrage vor Freigabe vor Abnahme vor allem anderen.
 */
export type AttentionTaskKind =
  'question' | 'approve' | 'acceptance' | 'evidence' | 'rule' | 'replan' | 'human' | 'retry' | 'wait';

export interface AttentionTask {
  kind: AttentionTaskKind;
  /** Text der Spalte „Zu tun“ (ohne Zähler, damit der Auswahlfilter je Art einen Wert hat). */
  label: string;
}

export const TASK_LABELS: Record<AttentionTaskKind, string> = {
  question: 'Rückfrage',
  approve: 'Freigabe',
  acceptance: 'Abnahme',
  evidence: 'Testnachweis',
  rule: 'Abgelehnt',
  replan: 'Einplanen',
  human: 'Aufgabe für dich',
  retry: 'Erneut versuchen',
  wait: 'Läuft',
};

/** Werte des Filters „Zu tun“ in der Rangfolge der Arten. */
export const TASK_FILTER_OPTIONS: readonly string[] = Object.values(TASK_LABELS);

/** Abnahme eines Auftrags unter „Aktionen“: offene Punkte zuerst, erfüllte eingeklappt dahinter. */
export interface AttentionAcceptance {
  /** Offen, nicht erfüllt, nur von Hand prüfbar oder gerade in Prüfung – in dieser Reihenfolge. */
  open: AcceptanceCheck[];
  met: AcceptanceCheck[];
  /** Punkte, die nur ein Mensch prüfen kann (Teil von `open`). */
  manual: number;
}

/** Ein Auftrag auf der Seite „Aktionen“: warum er wartet und was zu tun ist. */
export interface AttentionEntry {
  item: DevelopmentItem;
  reasons: AttentionReason[];
  /** Gründe ohne die Angabe, die das Status-Etikett schon zeigt. */
  badges: AttentionReason[];
  /** Punkte, die nur ein Mensch prüfen kann. */
  checks: AcceptanceCheck[];
  /** Abnahmeliste der Zeile: alle offenen Punkte des Testers, nicht nur die manuellen. */
  acceptance: AttentionAcceptance;
  /** Offene Testnachweise (Datei, Befehl, Grund) – Start als Testlauf oder Verweis auf die Rechte. */
  evidence: TestEvidence[];
  guide: OrderGuide | null;
  failure: FailureParts | null;
  /** Ein Grund und ein nächster Schritt für die Karte unter „Aktionen“. */
  card: AttentionCard;
  /** Spalte „Zu tun“. */
  task: AttentionTask;
}

/**
 * Der Abnahmehinweis „Selbst prüfen: …“ ist keine eigene Aktion: Die Punkte selbst stehen in der Abnahmeliste.
 * Sonst verschwände ein erledigter Auftrag mit manuellen Punkten von der Seite, weil der Hinweis als Aktion zählt.
 */
export function isManualTodo(todo: string | null | undefined): boolean {
  return !!todo && todo.startsWith(MANUAL_TODO_PREFIX);
}

/** Reihenfolge der offenen Punkte: manuell zuerst (die kann nur der Mensch erledigen), dann nicht erfüllt, dann offen. */
const OPEN_RANK: Record<AcceptanceCheck['status'], number> = {
  manual: 0,
  unmet: 1,
  open: 2,
  verifying: 3,
  checking: 3,
  met: 9,
};

/** Abnahmeliste nur, wo der Tester schon geurteilt hat: blockiert, in Freigabe oder erledigt. */
const ACCEPTANCE_STATUSES: readonly string[] = [
  DEVELOPMENT_STATUS.blocked,
  DEVELOPMENT_STATUS.approval,
  DEVELOPMENT_STATUS.done,
];

function acceptanceOf(item: DevelopmentItem, checks: AcceptanceCheck[]): AttentionAcceptance {
  if (!ACCEPTANCE_STATUSES.includes(item.status)) return { open: [], met: [], manual: 0 };
  const own = checks.filter((check) => check.developmentId === item.id && check.kind !== 'visual');
  const open = own
    .filter((check) => check.status !== 'met')
    .sort(
      (a, b) => OPEN_RANK[a.status] - OPEN_RANK[b.status] || a.kind.localeCompare(b.kind) || a.position - b.position,
    );
  return {
    open,
    met: own.filter((check) => check.status === 'met'),
    manual: open.filter((check) => check.status === 'manual').length,
  };
}

/** Die Art in der Spalte „Zu tun“ aus Karte, Abnahme und Nachweisen. */
export function attentionTask(
  card: Pick<AttentionCard, 'step'>,
  openChecks: number,
  openEvidence: number,
): AttentionTask {
  const kind = taskKind(card.step, openChecks, openEvidence);
  return { kind, label: TASK_LABELS[kind] };
}

function taskKind(step: AttentionCard['step'], openChecks: number, openEvidence: number): AttentionTaskKind {
  if (step === 'question') return 'question';
  if (step === 'approve') return 'approve';
  if (step === 'wait' || step === 'analyzing') return 'wait';
  if (openChecks) return 'acceptance';
  if (openEvidence) return 'evidence';
  switch (step) {
    case 'rule':
      return 'rule';
    case 'replan':
      return 'replan';
    case 'task':
      return 'human';
    case 'check':
      return 'acceptance';
    default:
      return 'retry';
  }
}

/**
 * Aufträge, die eine Entscheidung brauchen: wartet auf Freigabe, abgelehnt, blockiert bzw. mit offener Aktion,
 * aus dem Sprint genommen oder mit Punkten, die nur ein Mensch prüfen kann.
 */
export function orderAttention(
  development: DevelopmentItem[],
  acceptance: AcceptanceCheck[],
  evidence: TestEvidence[] = [],
): AttentionEntry[] {
  const manual = new Map<string, AcceptanceCheck[]>();
  for (const check of acceptance) {
    if (check.status === 'manual') manual.set(check.developmentId, [...(manual.get(check.developmentId) ?? []), check]);
  }
  // Abgehakte Nachweise (grüner Lauf) verschwinden; rote und nicht freigegebene bleiben sichtbar.
  const byOrder = new Map<string, TestEvidence[]>();
  for (const proof of evidence) {
    if (proof.status !== 'passed')
      byOrder.set(proof.developmentId, [...(byOrder.get(proof.developmentId) ?? []), proof]);
  }
  return development
    .map((item) => {
      const reasons: AttentionReason[] = [];
      const todo = isManualTodo(item.actionTodo) ? null : item.actionTodo;
      // Wartet der Auftrag auf einen Menschen, ist er nicht gescheitert, sondern braucht eine Aktion.
      // Schon freigegeben: wartet nur noch auf den Merge – steht unter „Läuft gerade“, nicht mehr bei dir.
      if (item.status === DEVELOPMENT_STATUS.approval && !item.reviewApprovedAt)
        reasons.push({ label: 'Wartet auf Freigabe', tone: 'info' });
      else if (item.status === DEVELOPMENT_STATUS.rejected)
        reasons.push({ label: 'Abgelehnt – verstösst gegen Projektregel', tone: 'error' });
      else if (item.status === DEVELOPMENT_STATUS.blocked || (todo && !isFinished(item.status)))
        reasons.push({ label: 'Aktion notwendig', tone: 'warn' });
      if (item.removedFromSprintAt && !isFinished(item.status)) {
        reasons.push({ label: `Aus Sprint „${item.removedFromSprint ?? '?'}“ genommen`, tone: 'info' });
      }
      // Von Hand prüfen lässt sich erst, was umgesetzt ist: geplante oder laufende Aufträge warten noch nicht auf dich.
      const testable =
        item.status === DEVELOPMENT_STATUS.done ||
        (item.status === DEVELOPMENT_STATUS.approval && !item.reviewApprovedAt);
      const checks = testable && !todo ? (manual.get(item.id) ?? []) : [];
      if (checks.length) {
        const open = checks.length;
        reasons.push({ label: `${open} Punkt${open === 1 ? '' : 'e'} von dir zu prüfen`, tone: 'warn' });
      }
      // Offene Testnachweise: eigener Grund, auch ohne action_todo und bei erledigten Aufträgen.
      const proofs = byOrder.get(item.id) ?? [];
      if (proofs.length) {
        if (!reasons.some((reason) => reason.label === 'Aktion notwendig'))
          reasons.push({ label: 'Aktion notwendig', tone: 'warn' });
        const count = proofs.length;
        reasons.push({ label: `${count} Testnachweis${count === 1 ? '' : 'e'} offen`, tone: 'warn' });
      }
      // Das Etikett neben dem Titel nennt den Status schon; dieselbe Angabe nicht noch einmal darunter zeigen.
      const badges = reasons.filter((reason) => reason.label !== statusLabel(item.status));
      const source = { ...item, actionTodo: todo };
      const card = attentionCard(source, checks.length, proofs.length);
      const list = reasons.length ? acceptanceOf(item, acceptance) : { open: [], met: [], manual: 0 };
      return {
        item,
        reasons,
        badges,
        checks,
        acceptance: list,
        evidence: proofs,
        guide: orderGuide(source),
        failure: item.failure ? failureParts(item.failure) : null,
        card,
        task: attentionTask(card, list.open.length, proofs.length),
      };
    })
    .filter((entry) => entry.reasons.length);
}
