import { NgClass } from '@angular/common';
import { Component, effect, inject, signal, untracked } from '@angular/core';
import { AuthService } from '../../core/auth.service.js';
import type { AcceptanceCheck, DevelopmentItem } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { BugIconComponent } from '../../shared/bug-icon.component.js';
import { isFinished } from '../../shared/labels.js';
import { MarkdownPipe } from '../../shared/markdown.pipe.js';
import { OrderQuestionComponent } from '../../shared/order-question.component.js';
import { StatusClassPipe, StatusLabelPipe } from '../../shared/pipes.js';
import { OrderApprovalComponent } from '../development/order-approval.component.js';
import { OrderDetailComponent } from '../development/order-detail.component.js';
import { OrderService } from '../development/order.service.js';

/**
 * Seite „Aktionen“: Rückmeldungen der Agents und alles, was auf dich wartet – Rückfragen, blockierte oder
 * abgelehnte Aufträge, Freigaben, aus dem Sprint genommene Aufträge und Punkte, die nur ein Mensch prüfen kann.
 * Diese Aufträge stehen nicht mehr in der Liste unter „Aufträge“.
 */
@Component({
  selector: 'app-actions',
  standalone: true,
  imports: [
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

  constructor() {
    // Aus einem Link (#actions/<id> oder umgeleitet von #development/<id>): Karte aufklappen und hinscrollen.
    effect(() => {
      const id = this.store.focusId();
      if (!id || !this.store.attentionIds().has(id)) return;
      untracked(() => {
        this.openAttention.set(id);
        globalThis.setTimeout(
          () => document.getElementById(`order-${id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
          200,
        );
      });
    });
  }

  /** Regel, gegen die ein abgelehnter Auftrag verstösst (aus dem Vermerk des Agents). */
  protected rule(item: DevelopmentItem): string {
    const vermerk = /\*\*Vermerk[^*]*:\*\*\s*([^\n]+)/.exec(item.failure ?? '')?.[1] ?? '';
    return vermerk.replace(/^Projektregel\s*–\s*/, '').trim();
  }

  protected analysisRunning(item: DevelopmentItem): boolean {
    return item.analysisStatus === 'requested' || item.analysisStatus === 'running';
  }

  /** Sprintbericht mit dem ToDo-Kapitel des Auftrags (falls der Sprint schon dokumentiert ist). */
  protected sprintDoc(item: DevelopmentItem): string | null {
    const sprintId = item.sprintId;
    return sprintId
      ? (this.data().docs.find((doc) => doc.kind === 'sprint' && doc.sprintId === sprintId)?.id ?? null)
      : null;
  }

  protected openDoc(id: string): void {
    this.store.navigate('docs', { focus: id });
  }

  /** Ohne gestarteten Behebungsauftrag stimmt „an einen Behebungsauftrag delegiert“ nicht: weglassen. */
  protected noteText(item: DevelopmentItem, note: string): string {
    return item.fixStatus ? note : note.replace(/\s*–\s*an einen Behebungsauftrag delegiert\.?$/, '.');
  }

  protected openBug(id: string): void {
    this.store.navigate('bugs', { focus: id });
  }

  protected retryOrder(item: DevelopmentItem): Promise<void> {
    return this.orders.retry(item);
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

  protected toggle(id: string): void {
    this.openAttention.set(this.openAttention() === id ? null : id);
  }
}
