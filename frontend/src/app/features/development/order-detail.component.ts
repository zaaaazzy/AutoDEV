import { NgTemplateOutlet } from '@angular/common';
import { OrderTimelineComponent } from '../../shared/order-timeline.component.js';
import { OrderQuestionComponent } from '../../shared/order-question.component.js';
import { OrderBriefComponent } from '../../shared/order-brief.component.js';
import { AgentWorkflowComponent } from '../../shared/agent-workflow.component.js';
import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { AcceptanceCheck, DevelopmentItem } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { visibleInterval } from '../../core/visible-interval.js';
import type { FormValues } from '../../shared/forms.js';
import { CATEGORIES, DEVELOPMENT_STATUSES } from '../../shared/labels.js';
import {
  MANUAL_DEVELOPMENT_TRANSITIONS,
  canSetDevelopmentStatus,
  isAssignableSprintStatus,
} from '../../../../../src/core/development-transitions.js';
import { MarkdownPipe } from '../../shared/markdown.pipe.js';
import { CategoryLabelPipe, HoursPipe, PriorityLabelPipe, StatusLabelPipe } from '../../shared/pipes.js';
import { parseRisks } from '../../shared/risk-list.js';
import { OrderService } from './order.service.js';
import { OrderApprovalComponent } from './order-approval.component.js';
import { OrderVisualComponent } from './order-visual.component.js';
import { needsVisual } from './needs-visual.js';
import { agentEnds, buildWorkflow } from '../../shared/workflow.js';

/** Aufgeklappte Detailansicht eines offenen Auftrags. */
@Component({
  selector: 'app-order-detail',
  standalone: true,
  imports: [
    OrderBriefComponent,
    OrderApprovalComponent,
    OrderVisualComponent,
    OrderQuestionComponent,
    OrderTimelineComponent,
    AgentWorkflowComponent,
    FormsModule,
    NgTemplateOutlet,
    MarkdownPipe,
    StatusLabelPipe,
    CategoryLabelPipe,
    PriorityLabelPipe,
    HoursPipe,
  ],
  templateUrl: './order-detail.component.html',
  host: { style: 'display: contents' },
})
export class OrderDetailComponent {
  private readonly orders = inject(OrderService);
  protected readonly store = inject(ProjectStore);
  protected readonly data = this.store.data;
  protected readonly busy = this.store.busy;
  protected readonly categories = CATEGORIES;
  protected readonly isAssignableSprintStatus = isAssignableSprintStatus;
  protected readonly manualAgent: Record<string, string> = {};

  readonly order = input.required<DevelopmentItem>();
  /**
   * Eingebettet unter „Aktionen“: ohne „Stand“, Blockiert-Kasten, Rückfrage und Freigabe – die zeigt die Zeile dort
   * schon, sonst stünde alles doppelt.
   */
  readonly embedded = input(false);

  /**
   * Status-Auswahl: aktueller Status plus die von Hand erlaubten Ziele (dieselbe Tabelle wie der Server).
   * In Arbeit, Freigabe und Erledigt setzt nur der Worker – dort bleibt die Auswahl gesperrt.
   */
  protected readonly statusOptions = computed(() => {
    const current = this.order().status;
    return DEVELOPMENT_STATUSES.filter((status) => canSetDevelopmentStatus(current, status));
  });
  protected readonly statusLocked = computed(() => !MANUAL_DEVELOPMENT_TRANSITIONS[this.order().status]);

  /** Sprint-Auswahl: nur geplante und aktive Sprints; der aktuell zugeordnete bleibt sichtbar. */
  protected readonly sprintOptions = computed(() => {
    const current = this.order().sprintId;
    return this.data().sprints.filter((sprint) => sprint.id === current || isAssignableSprintStatus(sprint.status));
  });
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
    const visual = checks.filter((check) => check.kind === 'visual');
    const todo = checks.filter((check) => check.status !== 'met');
    return {
      criteria,
      done,
      visual,
      todo,
      total: checks.length,
      verifying: todo.some((check) => this.isVerifying(check)),
    };
  });

  protected readonly showVisual = computed(() => needsVisual(this.order(), this.acceptance().visual.length));
  protected readonly agentEnds = computed(() => agentEnds(buildWorkflow(this.data(), this.order())));

  /**
   * Eigener Wahrheitswert: `acceptance()` liefert bei jedem Live-Refresh ein neues Objekt; hinge der Poll daran,
   * startete der Timer alle 3 s neu und feuerte nie.
   */
  private readonly verifying = computed(() => this.acceptance().verifying);

  constructor() {
    // Während der Tester prüft, den Stand regelmässig nachladen.
    effect((onCleanup) => {
      if (!this.verifying()) return;
      onCleanup(visibleInterval(() => void this.store.loadProject(this.store.activeProject(), true), 5000));
    });
  }

  /** Risiken des Bug-Wächters als einzelne Einträge. */
  protected readonly risks = computed(() => parseRisks(this.order().risks));

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
    const agentName = this.data().agents.find((agent) => agent.id === agentId)?.name;
    await this.orders.startWithAgent(item, agentId, agentName);
    delete this.manualAgent[item.id];
  }
}
