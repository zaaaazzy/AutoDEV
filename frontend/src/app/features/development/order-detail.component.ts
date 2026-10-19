import { NgTemplateOutlet } from '@angular/common';
import { OrderTimelineComponent } from '../../shared/order-timeline.component.js';
import { OrderQuestionComponent } from '../../shared/order-question.component.js';
import { OrderBriefComponent } from '../../shared/order-brief.component.js';
import { AgentWorkflowComponent } from '../../shared/agent-workflow.component.js';
import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { AcceptanceCheck, DevelopmentItem } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import type { FormValues } from '../../shared/forms.js';
import { CATEGORIES, DEVELOPMENT_STATUSES } from '../../shared/labels.js';
import { MarkdownPipe } from '../../shared/markdown.pipe.js';
import { CategoryLabelPipe, StatusLabelPipe } from '../../shared/pipes.js';
import { OrderService } from './order.service.js';

/** Aufgeklappte Detailansicht eines offenen Auftrags. */
@Component({
  selector: 'app-order-detail',
  standalone: true,
  imports: [
    OrderBriefComponent,
    OrderQuestionComponent,
    OrderTimelineComponent,
    AgentWorkflowComponent,
    FormsModule,
    NgTemplateOutlet,
    MarkdownPipe,
    StatusLabelPipe,
    CategoryLabelPipe,
  ],
  templateUrl: './order-detail.component.html',
  host: { style: 'display: contents' },
})
export class OrderDetailComponent {
  private readonly orders = inject(OrderService);
  protected readonly store = inject(ProjectStore);
  protected readonly data = this.store.data;
  protected readonly busy = this.store.busy;
  protected readonly developmentStatuses = DEVELOPMENT_STATUSES;
  protected readonly categories = CATEGORIES;
  protected readonly manualAgent: Record<string, string> = {};

  readonly order = input.required<DevelopmentItem>();
  readonly editing = input(false);
  /** Agent-Ansicht gleich aufgeklappt zeigen (z. B. auf der Agents-Seite). */
  readonly agentsOpen = input(false);
  readonly editCancelled = output<void>();
  readonly saved = output<FormValues>();

  /**
   * Abnahme des Testers: Akzeptanzkriterien und DoD-Punkte. Der DoD-Punkt „Alle Akzeptanzkriterien …“ zeigt die
   * Kriterien nochmals; alles noch nicht Erledigte steht zusätzlich unter „Noch zu erledigen“.
   */
  protected readonly acceptance = computed(() => {
    const checks = this.data().acceptance.filter((check) => check.developmentId === this.order().id);
    const criteria = checks.filter((check) => check.kind === 'criterion');
    const done = checks.filter((check) => check.kind === 'done');
    const todo = checks.filter((check) => check.status !== 'met');
    return { criteria, done, todo, total: checks.length, verifying: todo.some((check) => this.isVerifying(check)) };
  });

  constructor() {
    // Während der Tester prüft, den Stand regelmässig nachladen.
    effect((onCleanup) => {
      if (!this.acceptance().verifying) return;
      const timer = setInterval(() => void this.store.loadProject(this.store.activeProject(), true), 5000);
      onCleanup(() => clearInterval(timer));
    });
  }

  /** Formular für einen Folgeauftrag (nur bei erledigten Aufträgen). */
  protected readonly followUpOpen = signal(false);
  protected readonly activeSprintId = computed(
    () => this.data().sprints.find((sprint) => sprint.status === 'active')?.id ?? null,
  );
  /** Vorgänger, auf den sich dieser Auftrag bezieht. */
  protected readonly previous = computed(() => {
    const id = this.order().followUpOf;
    return id ? (this.data().development.find((item) => item.id === id) ?? null) : null;
  });

  protected async createFollowUp(
    item: DevelopmentItem,
    title: string,
    description: string,
    sprintId: string,
  ): Promise<void> {
    if (!title.trim()) return;
    const created = await this.orders.followUp(item, {
      title: title.trim(),
      description: description.trim(),
      sprintId: sprintId || null,
    });
    if (created) {
      this.followUpOpen.set(false);
      this.store.navigate('development', { focus: created });
    }
  }

  protected openPrevious(id: string): void {
    this.store.navigate('development', { focus: id });
  }

  protected coversCriteria(check: AcceptanceCheck): boolean {
    return /akzeptanzkriterien/i.test(check.text);
  }

  protected isVerifying(check: AcceptanceCheck): boolean {
    return check.status === 'verifying' || check.status === 'checking';
  }

  protected mark(check: AcceptanceCheck): string {
    if (this.isVerifying(check)) return '…';
    return check.status === 'met' ? '✓' : check.status === 'unmet' ? '✕' : check.status === 'manual' ? '👤' : '○';
  }

  protected checkPoint(item: DevelopmentItem, check: AcceptanceCheck, checked: boolean): Promise<void> {
    return this.orders.checkPoint(item, check, checked);
  }

  protected verifyPoints(item: DevelopmentItem, check?: AcceptanceCheck): Promise<void> {
    return this.orders.verifyPoints(item, check);
  }

  protected update(id: string, values: Partial<DevelopmentItem>): Promise<void> {
    return this.orders.update(id, values);
  }

  protected retry(item: DevelopmentItem): Promise<void> {
    return this.orders.retry(item);
  }

  protected analyze(item: DevelopmentItem): Promise<void> {
    return this.orders.analyze(item);
  }

  protected async startWithAgent(item: DevelopmentItem): Promise<void> {
    const agentId = this.manualAgent[item.id] || item.agentId;
    if (!agentId) return;
    await this.orders.startWithAgent(item, agentId);
    delete this.manualAgent[item.id];
  }
}
