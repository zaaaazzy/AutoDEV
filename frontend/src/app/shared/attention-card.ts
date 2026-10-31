import type { DevelopmentItem } from '../core/models.js';
import { DEVELOPMENT_STATUS } from '../core/models.js';
import { canRetryDevelopment } from '../../../../src/core/development-transitions.js';
import { failureParts, orderGuide } from './order-problem.js';
import { defined } from '../../../../src/core/defined.js';

/**
 * Was eine Karte unter „Aktionen“ als nächsten Schritt anbietet – genau einer je Auftrag:
 * - wait: Du musst nichts tun, es geht von selbst weiter.
 * - analyzing: Die Problemanalyse läuft gerade.
 * - retry: Erneut versuchen, auf Wunsch mit einem Hinweis an die Agents.
 * - suggestion: Der Assistent schlägt einen Weg vor; „So umsetzen lassen“ gibt ihn den Agents mit.
 * - task: Eine Aufgabe, die nur ein Mensch erledigen kann (Laufwerk, Zugang, Budget …).
 * - question: Rückfrage des Assistenten zu einer Express-Anfrage, direkt beantworten.
 * - approve: Fertig, wartet auf deine Freigabe.
 * - rule: Verstösst gegen eine Projektregel – anpassen oder löschen.
 * - replan: Aus dem Sprint genommen – wieder einplanen oder löschen.
 * - check: Punkte, die nur ein Mensch prüfen kann.
 */
export type CardStep =
  'wait' | 'analyzing' | 'retry' | 'suggestion' | 'task' | 'question' | 'approve' | 'rule' | 'replan' | 'check';

export interface AttentionCard {
  /** Warum der Auftrag wartet: ein Satz mit dem echten Grund. */
  why: string;
  step: CardStep;
  /** Was jetzt zu tun ist: ein Satz. */
  next: string;
  /** Vorschlag des Assistenten (bei `suggestion`) bzw. die Aufgabe (bei `task`). */
  detail: string | null;
  /** Agent, der die Meldung ausgelöst hat (z. B. „Tester“), falls bekannt. */
  agent?: string | null;
}

type CardSource = Pick<
  DevelopmentItem,
  | 'status'
  | 'kind'
  | 'failure'
  | 'analysis'
  | 'actionTodo'
  | 'analysisStatus'
  | 'fixStatus'
  | 'removedFromSprint'
  | 'removedFromSprintAt'
>;

const MAX = 220;

const clean = (text: string): string =>
  text
    .replace(/[*`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Auf ganze Sätze kürzen, sonst mit „…“. */
function short(text: string, max = MAX): string {
  const plain = clean(text);
  if (plain.length <= max) return plain;
  let result = '';
  for (const sentence of plain.split(/(?<=[.!?])\s+/)) {
    if ((result + sentence).length > max) break;
    result += `${result ? ' ' : ''}${sentence}`;
  }
  return result || `${plain.slice(0, max - 1)}…`;
}

const sentence = (text: string): string => {
  // Ein Satz, der mit „:“ eine Aufzählung ankündigt, endet hier ohne sie: Doppelpunkt durch Punkt ersetzen.
  const plain = clean(text).replace(/\s*[:;,]$/, '');
  return !plain || /[.!?…]$/.test(plain) ? plain : `${plain}.`;
};

/** Erste aussagekräftige Zeile einer Meldung, ohne Kopfzeile „Agent … scheiterte:“ und ohne Überschriften. */
function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) =>
        line.trim().replace(/^Agent „[^“]+“ (?:scheiterte|hat angehalten|konnte nicht arbeiten)[^:]*[:.]?\s*/, ''),
      )
      .find(
        (line) =>
          line &&
          !line.startsWith('#') &&
          !line.startsWith('```') &&
          !/^\*\*(?:Bug|Vermerk|Testergebnis|Ausgabe)/.test(line) &&
          !/^Agent „[^“]+“/.test(line),
      ) ?? ''
  );
}

/** Aufgaben, die ein Agent nicht selbst erledigen kann. */
const HUMAN_TASK =
  /Projektordner|Laufwerk|anschliessen|Budget|Arbeitsordner aufräumen|Zugang|Zugangsdaten|Token|Passwort|Datenbank-URL|Lizenz|Konto/i;
/** „keine …“: laut Analyse muss niemand etwas beheben. */
const NOTHING = /^\s*(?:keine|nichts)\b/i;

/** Der echte Grund, warum ein blockierter Auftrag steht – in einem Satz. */
export function blockedReason(item: Pick<CardSource, 'failure' | 'analysis' | 'actionTodo'>): string {
  const failure = item.failure ?? '';
  if (failure) {
    const parts = failureParts(failure);
    const agent = parts.agent || 'Ein Agent';
    if (parts.unmet.length) {
      const first = defined(parts.unmet[0]);
      const others = parts.unmet.length - 1;
      const more = others ? ` (und ${others} ${others === 1 ? 'weiterer Punkt' : 'weitere Punkte'})` : '';
      return short(`${agent}: Abnahme nicht bestanden – ${first.reason || first.criterion}${more}`);
    }
    const red = /\*\*Testergebnis:\*\*[^\n]*?(\d+) fehlgeschlagen/.exec(failure);
    const count = Number(red?.[1] ?? 0);
    if (count > 0) {
      const name = /\*\*Fehlgeschlagen:\*\*\s*\n-\s*\*\*([^*]+)\*\*/.exec(failure)?.[1];
      return short(
        `${agent}: ${count} ${count === 1 ? 'Test ist' : 'Tests sind'} rot${name ? ` – „${name.trim()}“` : ''}`,
      );
    }
    if (/Nutzungslimit|hit your (?:session|usage|weekly|daily)? ?limit/i.test(failure)) {
      return 'Das Nutzungslimit des Agent-Kontos war erreicht.';
    }
  }
  const cause = orderGuide({ status: 'blocked', failure: item.failure, analysis: item.analysis, actionTodo: null });
  const fromAnalysis = item.analysis ? cause?.problem : '';
  const line = firstLine(failure);
  return sentence(short(fromAnalysis || line || 'Ein Agent ist gescheitert, die Ursache ist nicht klar.'));
}

/** Projektregel aus dem Vermerk eines abgelehnten Auftrags. */
function ruleOf(failure: string | null | undefined): string {
  const vermerk = /\*\*Vermerk[^*]*:\*\*\s*([^\n]+)/.exec(failure ?? '')?.[1] ?? '';
  return clean(vermerk.replace(/^Projektregel\s*–\s*/, '').replace(/\s*–\s*Auftrag anpassen oder verwerfen\.?$/, ''));
}

/** Eine Karte unter „Aktionen“: ein Grund, ein nächster Schritt, und welcher Agent die Meldung ausgelöst hat. */
export function attentionCard(item: CardSource, manualChecks = 0): AttentionCard {
  const card = buildCard(item, manualChecks);
  const agent =
    item.status === DEVELOPMENT_STATUS.blocked && item.failure ? failureParts(item.failure).agent || null : null;
  return { ...card, agent };
}

function buildCard(item: CardSource, manualChecks: number): AttentionCard {
  if (item.status === DEVELOPMENT_STATUS.approval) {
    return { why: 'Fertig – wartet auf deine Freigabe.', step: 'approve', next: '', detail: null };
  }
  if (item.status === DEVELOPMENT_STATUS.rejected) {
    const rule = ruleOf(item.failure);
    return {
      why: rule ? `Verstösst gegen die Projektregel: ${sentence(rule)}` : 'Verstösst gegen eine Projektregel.',
      step: 'rule',
      next: 'Passe den Auftrag an (unter „Mehr“ → „Bearbeiten“) und versuche ihn erneut – oder lösche ihn.',
      detail: null,
    };
  }
  if (item.status !== DEVELOPMENT_STATUS.blocked) {
    // Nach einem Sprint-Abbruch läuft der Agent noch: erst nach seinem Ende ist der Auftrag im Backlog und lässt sich
    // wieder einplanen (vorher lehnt /retry mit 409 ab).
    if (item.removedFromSprintAt && item.status === DEVELOPMENT_STATUS.inProgress) {
      return {
        why: `Aus Sprint „${item.removedFromSprint ?? '?'}“ genommen – der Agent wird gerade beendet.`,
        step: 'wait',
        next: 'Danach kannst du ihn wieder einplanen.',
        detail: null,
      };
    }
    if (item.removedFromSprintAt && canRetryDevelopment(item)) {
      return {
        why: `Aus Sprint „${item.removedFromSprint ?? '?'}“ genommen – in keinem Sprint mehr eingeplant.`,
        step: 'replan',
        next: 'Plane ihn wieder ein oder lösche ihn.',
        detail: null,
      };
    }
    if (manualChecks) {
      return {
        why:
          manualChecks === 1
            ? 'Ein Punkt lässt sich nur von Hand prüfen.'
            : `${manualChecks} Punkte lassen sich nur von Hand prüfen.`,
        step: 'check',
        next: 'Probiere es in der Anwendung aus und hake ab, was stimmt.',
        detail: null,
      };
    }
    const todo = clean(item.actionTodo ?? '');
    return { why: todo ? sentence(todo) : 'Wartet auf dich.', step: 'task', next: '', detail: null };
  }

  // Blockiert.
  if (item.kind === 'express') {
    return item.actionTodo
      ? { why: 'Der Assistent hat eine Rückfrage.', step: 'question', next: '', detail: null }
      : {
          why: blockedReason(item),
          step: 'task',
          next: 'Stell die Anfrage im Dashboard-Chat neu.',
          detail: null,
        };
  }
  const why = blockedReason(item);
  if (item.analysisStatus === 'requested' || item.analysisStatus === 'running') {
    return {
      why,
      step: 'analyzing',
      next: 'Der Assistent analysiert gerade – die Karte aktualisiert sich gleich.',
      detail: null,
    };
  }
  if (item.fixStatus === DEVELOPMENT_STATUS.planned || item.fixStatus === DEVELOPMENT_STATUS.inProgress) {
    return {
      why,
      step: 'wait',
      next: 'Du musst nichts tun: Ein Behebungsauftrag läuft, danach startet dieser Auftrag von selbst neu.',
      detail: null,
    };
  }
  if (item.fixStatus === 'done') {
    return { why, step: 'retry', next: 'Der Fehler ist behoben – starte den Auftrag neu.', detail: null };
  }
  const todo = clean(item.actionTodo ?? '');
  if (todo && !NOTHING.test(todo) && HUMAN_TASK.test(todo)) {
    return { why, step: 'task', next: 'Das kann nur ein Mensch erledigen. Danach erneut versuchen.', detail: todo };
  }
  const guide = orderGuide(item);
  if ((todo && NOTHING.test(todo)) || guide?.nothingToFix) {
    return {
      why,
      step: 'retry',
      next: 'Laut Analyse musst du nichts beheben – einfach erneut versuchen.',
      detail: null,
    };
  }
  const suggestion = todo || (guide?.steps.length ? guide.steps.join('; ') : '');
  if (suggestion) {
    return {
      why,
      step: 'suggestion',
      next: 'Der Assistent schlägt vor, so weiterzumachen. Lass es umsetzen oder gib den Agents eine eigene Anweisung.',
      detail: short(suggestion, 400),
    };
  }
  return {
    why,
    step: 'retry',
    next: 'Versuch es erneut – wenn du weisst, was fehlt, schreib es den Agents dazu.',
    detail: null,
  };
}

/** Hinweis für die Agents beim erneuten Versuch: Vorschlag der Analyse (falls umgesetzt werden soll) und Ergänzung. */
export function retryComment(card: Pick<AttentionCard, 'step' | 'detail'>, note: string): string | null {
  const parts = [
    card.step === 'suggestion' && card.detail ? `Bitte so umsetzen (Vorschlag der Analyse): ${card.detail}` : '',
    note.trim() ? `Ergänzung: ${note.trim()}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join('\n') : null;
}
