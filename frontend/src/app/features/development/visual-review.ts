import type { DevelopmentStatus, ReviewSlot } from '../../core/models.js';
import { reviewStatusText } from '../sprints/review-launch.js';
import { DEVELOPMENT_STATUS } from '../../core/models.js';

/**
 * Hover-Text zur optischen Abnahme: wozu sie dient und wie sie sich von den anderen Knöpfen der Karte unterscheidet.
 * Die Freigabe hält nur fest, wer das Aussehen wann geprüft hat; sie startet und stoppt nichts.
 */
export const VISUAL_REVIEW_WHY =
  'Optische Abnahme der Frontend-Änderungen: Den Auftrag in einer Umgebung ansehen, das Aussehen prüfen und danach ' +
  'optisch freigeben. Die Freigabe hält fest, wer das Aussehen wann geprüft hat. Sie ersetzt weder die Freigabe des ' +
  'Auftrags noch „Erneut versuchen“ – das lässt die Agents am Auftrag weiterarbeiten.';

/** Farbe des Statuspunkts einer Umgebung. */
export type SlotTone = 'off' | 'idle' | 'busy' | 'ok' | 'error';

export function slotTone(slot: Pick<ReviewSlot, 'enabled' | 'status'>): SlotTone {
  if (!slot.enabled) return 'off';
  switch (slot.status) {
    case 'running':
      return 'ok';
    case 'failed':
      return 'error';
    case 'idle':
      return 'idle';
    default:
      return 'busy';
  }
}

/** Die Umgebung zeigt diesen Auftrag (läuft, startet oder ist damit gescheitert). */
export function showsOrder(slot: Pick<ReviewSlot, 'developmentId' | 'status'>, orderId: string): boolean {
  return slot.developmentId === orderId && slot.status !== 'idle' && slot.status !== 'stopping';
}

/** Statuszeile einer Umgebung: gesperrt, frei oder der Status des Containers. */
export function slotStatusText(slot: Pick<ReviewSlot, 'enabled' | 'status' | 'message'>): string {
  if (!slot.enabled) return 'gesperrt';
  return reviewStatusText(slot);
}

/**
 * Welcher Stand geladen ist: Beschriftung und Commit (7 Zeichen). Leer bei einer freien Umgebung; Container anderer
 * Projekte liefert der Server ohne Inhalt (Mandantentrennung).
 */
export function slotLoadedText(slot: Pick<ReviewSlot, 'status' | 'projectSlug' | 'label' | 'commit'>): string {
  if (slot.status === 'idle') return 'kein Stand geladen';
  if (!slot.projectSlug) return 'belegt von einem anderen Projekt';
  const label = slot.label?.trim() || 'Stand';
  return slot.commit ? `${label} · ${slot.commit.slice(0, 7)}` : `${label} · Stand wird beim Start bestimmt`;
}

/** Eintrag im Dropdown: „Umgebung 2 – Review läuft · dieser Auftrag“. */
export function slotOptionText(slot: ReviewSlot, orderId: string): string {
  const own = showsOrder(slot, orderId) ? ' · dieser Auftrag' : '';
  return `Umgebung ${slot.slot} – ${slotStatusText(slot)}${own}`;
}

/**
 * Vorauswahl: die Umgebung mit diesem Auftrag, sonst eine freie, sonst eine fehlerhafte (dort geht nichts verloren),
 * sonst die erste freigegebene.
 */
export function defaultSlot(slots: ReviewSlot[], orderId: string): number | null {
  const enabled = slots.filter((slot) => slot.enabled);
  return (
    enabled.find((slot) => showsOrder(slot, orderId))?.slot ??
    enabled.find((slot) => slot.status === 'idle')?.slot ??
    enabled.find((slot) => slot.status === 'failed')?.slot ??
    enabled[0]?.slot ??
    null
  );
}

/** Text des Start-Knopfs: sagt, was passiert – laden, ersetzen, neu laden oder die Umgebung neu starten. */
export function spawnLabel(slot: ReviewSlot | null, orderId: string): string {
  if (!slot) return '▶ Auftrag laden';
  if (showsOrder(slot, orderId)) return slot.status === 'failed' ? '↻ Umgebung neu starten' : '↻ Auftrag neu laden';
  return slot.status === 'idle' || slot.status === 'failed' ? '▶ Auftrag laden' : '▶ Auftrag laden (ersetzt den Stand)';
}

/** Erklärung zu einer fehlerhaften Umgebung und was dagegen hilft; leer, solange sie nicht fehlerhaft ist. */
export function slotErrorHint(slot: Pick<ReviewSlot, 'status' | 'message'>, own: boolean): string {
  if (slot.status !== 'failed') return '';
  const ended = /container beendet/i.test(slot.message ?? '');
  const what = ended
    ? 'Der Container hat sich beendet und zeigt nichts mehr an.'
    : 'Der Container konnte nicht gestartet werden.';
  return own
    ? `${what} „Umgebung neu starten“ lädt den Auftrag nochmals; scheitert es wieder, die Meldung an einen Administrator geben.`
    : `${what} „Aufräumen“ setzt die Umgebung zurück; danach ist sie wieder frei.`;
}

/** Technische Meldung einer fehlerhaften Umgebung ohne die erste Zeile (die steht schon im Status). */
export function slotErrorLog(slot: Pick<ReviewSlot, 'status' | 'message'>): string {
  if (slot.status !== 'failed') return '';
  return (slot.message ?? '').split('\n').slice(1).join('\n').trim();
}

/** Ton der Statuszeile: erledigt, zu tun, warten, Fehler. */
export type VisualTone = 'done' | 'todo' | 'wait' | 'error';

/** Statuszeile oben in der optischen Abnahme: in welchem Zustand der Auftrag ist und was (falls etwas) zu tun ist. */
export interface VisualStatus {
  tone: VisualTone;
  title: string;
  next: string;
  /** „Optisch freigeben“ anbieten (nur, wenn der Stand fertig ist und noch nicht freigegeben). */
  canApprove: boolean;
}

/** Leitet die Statuszeile aus Freigabe, Auftragsstatus und der Umgebung mit diesem Auftrag ab. */
export function visualStatus(state: {
  approved: boolean;
  orderStatus: DevelopmentStatus;
  own: Pick<ReviewSlot, 'slot' | 'status' | 'message'> | null;
  /** Gibt es überhaupt eine Umgebung (geladen und mindestens eine eingerichtet)? */
  hasSlots: boolean;
}): VisualStatus {
  const { approved, orderStatus, own } = state;
  if (approved) {
    return {
      tone: 'done',
      title: 'Bereits optisch freigegeben – nichts zu tun.',
      next: 'Die Abnahme-Schritte sind nur noch zum Nachschauen da. Ändert sich der Auftrag noch, kann die Freigabe dort zurückgenommen werden.',
      canApprove: false,
    };
  }
  if (orderStatus === DEVELOPMENT_STATUS.inProgress) {
    return {
      tone: 'wait',
      title: 'Der Auftrag wird gerade bearbeitet – noch nichts zu tun.',
      next: 'Ansehen und optisch freigeben geht, sobald die Agents fertig sind.',
      canApprove: false,
    };
  }
  if (orderStatus === 'blocked' || orderStatus === 'rejected') {
    return {
      tone: 'wait',
      title: 'Optisch prüfen erst, wenn der Auftrag fertig bearbeitet ist.',
      next:
        'Der Auftrag muss zuerst weiterbearbeitet werden – z. B. mit „Erneut versuchen“ in dieser Karte. Dabei ändert ' +
        'sich der Stand; eine optische Freigabe jetzt würde für einen veralteten Stand gelten. Ansehen geht trotzdem.',
      canApprove: false,
    };
  }
  if (own?.status === 'failed') {
    return {
      tone: 'error',
      title: `Umgebung ${own.slot} fehlerhaft – neu starten.`,
      next: `${slotErrorHint(own, true)} Danach ansehen und optisch freigeben.`,
      canApprove: true,
    };
  }
  if (own?.status === 'requested' || own?.status === 'starting') {
    return {
      tone: 'wait',
      title: `Umgebung ${own.slot} startet – gleich ansehen.`,
      next: 'Das dauert meist ein, zwei Minuten; die Anzeige aktualisiert sich von selbst.',
      canApprove: true,
    };
  }
  if (own?.status === 'running') {
    return {
      tone: 'todo',
      title: `Bitte in Umgebung ${own.slot} ansehen und freigeben.`,
      next: '„Öffnen ↗“ zeigt den Auftrag. Stimmt das Aussehen, unten „Optisch freigeben“.',
      canApprove: true,
    };
  }
  if (!state.hasSlots) {
    return {
      tone: 'todo',
      title: 'Bitte die Änderungen prüfen und freigeben.',
      next: 'Es ist keine Umgebung eingerichtet – geänderte Dateien und Screenshots unten ansehen, dann optisch freigeben.',
      canApprove: true,
    };
  }
  return {
    tone: 'todo',
    title: 'Bitte ansehen und freigeben.',
    next: 'Den Auftrag in einer Umgebung laden (Schritt 1), das Aussehen prüfen und danach optisch freigeben.',
    canApprove: true,
  };
}
