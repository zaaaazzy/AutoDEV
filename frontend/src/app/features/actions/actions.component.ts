import { NgClass } from '@angular/common';
import { Component, effect, HostListener, inject, signal, untracked } from '@angular/core';
import { AuthService } from '../../core/auth.service.js';
import type { AcceptanceCheck, DevelopmentItem } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { BugIconComponent } from '../../shared/bug-icon.component.js';
import type { AttentionCard, CardStep } from '../../shared/attention-card.js';
import { isFinished } from '../../shared/labels.js';
import { MarkdownPipe } from '../../shared/markdown.pipe.js';
import { OrderQuestionComponent } from '../../shared/order-question.component.js';
import { StatusClassPipe, StatusLabelPipe } from '../../shared/pipes.js';
import { OrderApprovalComponent } from '../development/order-approval.component.js';
import { OrderDetailComponent } from '../development/order-detail.component.js';
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
    NgClass,
    BugIconComponent,
    MarkdownPipe,
    OrderApprovalComponent,
    OrderDetailComponent,
    OrderQuestionComponent,
    StatusClassPipe,
    StatusLabelPipe,
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
  protected readonly openAttention = signal<string | null>(null);
  /** Geöffnetes Menü „Mehr“ (Auftrags-ID); schliesst mit Escape, Klick daneben oder Wahl eines Eintrags. */
  protected readonly moreOpen = signal<string | null>(null);
  /** Antwort bzw. Hinweis an die Agents je Auftrag, bis „Erneut versuchen“ ihn mitschickt. */
  private readonly notes = signal<Record<string, string>>({});

  constructor() {
    // Aus einem Link (#actions/<id> oder umgeleitet von #development/<id>): zur Karte scrollen und sie hervorheben.
    // Nicht mehr die Bearbeitung aufklappen – die wiederholte sonst alles, was die Karte schon sagt.
    effect(() => {
      const id = this.store.focusId();
      if (!id || !this.store.attentionIds().has(id)) return;
      untracked(() => {
        globalThis.setTimeout(
          () => document.getElementById(`order-${id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
          200,
        );
      });
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

  @HostListener('document:keydown.escape')
  @HostListener('document:click')
  protected closeMore(): void {
    if (this.moreOpen()) this.moreOpen.set(null);
  }

  protected toggle(id: string): void {
    this.openAttention.set(this.openAttention() === id ? null : id);
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

  /** Die eine Hauptaktion der Karte; null, wenn es nichts zu klicken gibt (z. B. Behebung läuft). */
  protected primaryLabel(item: DevelopmentItem, step: CardStep): string | null {
    const typed = !!this.note(item.id).trim();
    switch (step) {
      case 'suggestion':
        return typed ? 'Mit meiner Anweisung erneut versuchen' : 'So umsetzen lassen';
      case 'retry':
      case 'task':
        if (item.kind === 'express') return null;
        return this.auth.can('run') ? (typed ? 'Antworten und erneut versuchen' : 'Erneut versuchen') : null;
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

  protected async primary(item: DevelopmentItem, card: AttentionCard): Promise<void> {
    if (card.step === 'check') return this.confirmOrder(item);
    const typed = this.note(item.id).trim();
    const comment =
      typed ||
      (card.step === 'suggestion' && card.detail ? `Bitte so umsetzen (Vorschlag der Analyse): ${card.detail}` : '');
    await this.orders.retryNow(item, comment || null);
    this.setNote(item.id, '');
  }
}
