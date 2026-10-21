import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { AuthService } from '../../core/auth.service.js';
import type { AcceptanceCheck, DevelopmentItem } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import type { AttentionCard, CardStep } from '../../shared/attention-card.js';
import type { AttentionEntry } from '../../shared/order-attention.js';
import { isFinished } from '../../shared/labels.js';
import { MarkdownPipe } from '../../shared/markdown.pipe.js';
import { OrderQuestionComponent } from '../../shared/order-question.component.js';
import { OrderApprovalComponent } from '../development/order-approval.component.js';
import { OrderDetailComponent } from '../development/order-detail.component.js';
import { OrderDetailSlotDirective, OrderTableComponent } from '../development/order-table.component.js';
import { OrderService } from '../development/order.service.js';
import { AcceptanceReviewComponent } from './acceptance-review.component.js';

/**
 * Seite „Aktionen“: Rückmeldungen der Agents und alles, was auf dich wartet – Rückfragen, blockierte oder
 * abgelehnte Aufträge, Freigaben, aus dem Sprint genommene Aufträge und Punkte, die nur ein Mensch prüfen kann.
 * Diese Aufträge stehen nicht mehr in der Liste unter „Aufträge“.
 */
@Component({
  selector: 'app-actions',
  standalone: true,
  imports: [
    AcceptanceReviewComponent,
    MarkdownPipe,
    OrderApprovalComponent,
    OrderDetailComponent,
    OrderDetailSlotDirective,
    OrderQuestionComponent,
    OrderTableComponent,
  ],
  templateUrl: './actions.component.html',
  host: { style: 'display: contents' },
})
export class ActionsComponent {
  private readonly orders = inject(OrderService);
  protected readonly store = inject(ProjectStore);
  protected readonly auth = inject(AuthService);
  protected readonly data = this.store.data;
  protected readonly busy = this.store.busy;
  protected readonly isFinished = isFinished;
  protected readonly attention = this.store.attention;
  /** Zeilen der Tabelle – dieselbe Darstellung wie unter „Aufträge“. */
  protected readonly items = computed(() => this.attention().map((entry) => entry.item));
  private readonly entries = computed(() => new Map(this.attention().map((entry) => [entry.item.id, entry])));
  /** Aufträge mit eingeblendeten Auftragsdetails (Knopf „Details“); zu ist der Normalfall. */
  private readonly detailsShown = signal<ReadonlySet<string>>(new Set());
  /** Antwort bzw. Hinweis an die Agents je Auftrag, bis „Erneut versuchen“ ihn mitschickt. */
  private readonly notes = signal<Record<string, string>>({});

  constructor() {
    // Aus einem Link (#actions/<id> oder umgeleitet von #development/<id>): Die Tabelle klappt die Zeile auf,
    // hier wird nur hingescrollt.
    effect(() => {
      const id = this.store.focusId();
      if (!id || !this.store.attentionIds().has(id)) return;
      untracked(() =>
        globalThis.setTimeout(() => {
          const target = document.getElementById(`order-${id}`)?.closest('tr')?.previousElementSibling;
          (target ?? document.querySelector('.attention-table .row-open'))?.scrollIntoView({
            block: 'start',
            behavior: 'smooth',
          });
        }, 200),
      );
    });
  }

  /** Ohne gestarteten Behebungsauftrag stimmt „an einen Behebungsauftrag delegiert“ nicht: weglassen. */
  protected noteText(item: DevelopmentItem, note: string): string {
    return item.fixStatus ? note : note.replace(/\s*–\s*an einen Behebungsauftrag delegiert\.?$/, '.');
  }

  protected openBug(id: string): void {
    this.store.navigate('bugs', { focus: id });
  }

  protected analyzeOrder(item: DevelopmentItem): Promise<void> {
    return this.orders.analyze(item);
  }

  protected deleteOrder(item: DevelopmentItem): Promise<void> {
    return this.orders.remove(item);
  }

  protected confirmOrder(item: DevelopmentItem): Promise<void> {
    return this.orders.confirmChecks(item);
  }

  protected checkPoint(item: DevelopmentItem, check: AcceptanceCheck): Promise<void> {
    return this.orders.checkPoint(item, check, true);
  }

  protected entryOf(id: string): AttentionEntry | null {
    return this.entries().get(id) ?? null;
  }

  protected detailsOpen(id: string): boolean {
    return this.detailsShown().has(id);
  }

  protected toggleDetails(id: string): void {
    this.detailsShown.update((shown) => {
      const next = new Set(shown);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  protected approve(item: DevelopmentItem): Promise<void> {
    return this.orders.approve(item);
  }

  protected reject(item: DevelopmentItem): Promise<void> {
    return this.orders.rejectReview(item);
  }

  protected note(id: string): string {
    return this.notes()[id] ?? '';
  }

  protected setNote(id: string, value: string): void {
    this.notes.update((notes) => ({ ...notes, [id]: value }));
  }

  /** Antwortfeld nur, wo eine Antwort den Auftrag weiterbringt (blockiert und neu startbar). */
  protected canAnswer(item: DevelopmentItem, step: CardStep): boolean {
    return (
      item.status === 'blocked' &&
      item.kind !== 'express' &&
      this.auth.can('run') &&
      (step === 'retry' || step === 'suggestion' || step === 'task')
    );
  }

  /** Die eine Hauptaktion der Zeile; null, wenn es nichts zu klicken gibt (z. B. Behebung läuft). */
  protected primaryLabel(item: DevelopmentItem, step: CardStep): string | null {
    switch (step) {
      case 'suggestion':
        return this.auth.can('run') ? 'So umsetzen lassen' : null;
      case 'retry':
      case 'task':
        return item.kind !== 'express' && this.auth.can('run') ? 'Erneut versuchen' : null;
      case 'rule':
        return this.auth.can('run') ? 'Angepasst – erneut versuchen' : null;
      case 'replan':
        return this.auth.can('run') ? 'Wieder einplanen' : null;
      case 'check':
        return this.auth.can('plan') ? 'Geprüft – alles in Ordnung' : null;
      default:
        return null;
    }
  }

  /**
   * Hauptaktion ausführen – immer erst nach Bestätigung im Dialog. Beim Vorschlag gehen Vorschlag und deine
   * Ergänzung gemeinsam an die Agents; die Ergänzung ersetzt den Vorschlag nicht.
   */
  protected async primary(item: DevelopmentItem, card: AttentionCard, label: string): Promise<void> {
    if (card.step === 'check') return this.confirmOrder(item);
    const done = await this.orders.retryNow(item, {
      label,
      note: this.note(item.id),
      suggestion: card.step === 'suggestion' ? card.detail : null,
    });
    if (done) this.setNote(item.id, '');
  }
}
