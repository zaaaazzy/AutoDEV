import { GitGraphPanelComponent } from './git-graph-panel.component.js';
import { CoveragePanelComponent } from './coverage-panel.component.js';
import { TestMethodsPanelComponent } from './test-methods-panel.component.js';
import { ProductionTileComponent } from './production-tile.component.js';
import { BudgetPanelComponent } from './budget-panel.component.js';
import { NgClass } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { AgentActivityService } from '../../core/agent-activity.service.js';
import type { DevelopmentItem } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import {
  CATEGORIES,
  categoryLabel,
  isFinished,
  priorityLabel,
  severityLabel,
  statusLabel,
} from '../../shared/labels.js';
import { DateTimePipe, HoursPipe, LocaleNumberPipe, StatusClassPipe, StatusLabelPipe } from '../../shared/pipes.js';
import { ShareBarComponent, type ShareSegment } from '../../shared/share-bar.component.js';
import { AgentListComponent } from '../agents/agent-list.component.js';
import { ChatComponent } from '../chat/chat.component.js';

/** Farbton je Status, überall gleich: grün erledigt, blau in Arbeit, orange wartet/Warnung, rot Fehler. */
const ORDER_TONES: Record<string, string> = {
  backlog: 'neutral',
  planned: 'info',
  in_progress: 'active',
  blocked: 'warn',
  done: 'ok',
  rejected: 'neutral',
};
const ORDER_STATUSES = ['done', 'in_progress', 'planned', 'backlog', 'rejected', 'blocked'] as const;
const OPEN_IDEA_STATUSES = ['idea', 'considering', 'review', 'requested', 'drafting'];
const RECENT_RUNS = 20;

/**
 * Dashboard: alle Anteile als einheitliche 100-%-Balken. Die Zahlen stammen aus denselben Daten wie die
 * Listen-Seiten, und jeder Abschnitt öffnet die Seite mit dem passenden Filter.
 */
@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    NgClass,
    AgentListComponent,
    ChatComponent,
    CoveragePanelComponent,
    TestMethodsPanelComponent,
    GitGraphPanelComponent,
    ProductionTileComponent,
    BudgetPanelComponent,
    ShareBarComponent,
    DateTimePipe,
    HoursPipe,
    LocaleNumberPipe,
    StatusClassPipe,
    StatusLabelPipe,
  ],
  templateUrl: './dashboard.component.html',
  host: { style: 'display: contents' },
})
export class DashboardComponent {
  protected readonly store = inject(ProjectStore);
  private readonly agentActivity = inject(AgentActivityService);
  protected readonly data = this.store.data;
  protected readonly worker = this.store.worker;
  protected readonly recentRuns = RECENT_RUNS;

  protected readonly activeSprint = computed(
    () => this.data().sprints.find((sprint) => sprint.status === 'active') ?? null,
  );
  protected readonly openIdeasCount = computed(
    () => this.data().ideas.filter((idea) => OPEN_IDEA_STATUSES.includes(idea.status)).length,
  );
  protected readonly ratedIdeas = computed(() =>
    this.data()
      .ideas.filter(
        (idea) =>
          OPEN_IDEA_STATUSES.includes(idea.status) &&
          idea.benefit !== null &&
          idea.benefit !== undefined &&
          idea.cost !== null &&
          idea.cost !== undefined,
      )
      .sort((a, b) => (b.benefit ?? 0) - (b.cost ?? 0) - ((a.benefit ?? 0) - (a.cost ?? 0))),
  );

  /** Aufträge nach Status; Blockierte stehen auf der Seite „Aktionen“. */
  protected readonly orderShares = computed(() => this.orderSegments(this.data().development));

  protected readonly sprintShares = computed(() => {
    const sprint = this.activeSprint();
    if (!sprint) return [];
    return this.orderSegments(
      this.data().development.filter((item) => item.sprintId === sprint.id),
      sprint.name,
    );
  });

  protected readonly ideaShares = computed<ShareSegment[]>(() => {
    const ideas = this.data().ideas;
    const orderOf = new Map(
      this.data()
        .development.filter((item) => item.ideationId)
        .map((item) => [item.ideationId!, item]),
    );
    const openLabels = [...new Set(OPEN_IDEA_STATUSES.map(statusLabel))];
    const accepted = ideas.filter((idea) => idea.status === 'accepted');
    return [
      {
        label: 'Offen',
        value: ideas.filter((idea) => OPEN_IDEA_STATUSES.includes(idea.status)).length,
        tone: 'wait',
        link: { section: 'ideation', filters: { status: openLabels } },
      },
      {
        label: 'In Umsetzung',
        value: accepted.filter((idea) => orderOf.get(idea.id)?.status !== 'done').length,
        tone: 'active',
        link: { section: 'ideation' },
      },
      {
        label: 'Umgesetzt',
        value:
          accepted.filter((idea) => orderOf.get(idea.id)?.status === 'done').length +
          ideas.filter((idea) => idea.status === 'implemented').length,
        tone: 'ok',
        link: { section: 'ideation' },
      },
      {
        label: 'Verworfen',
        value: ideas.filter((idea) => idea.status === 'rejected').length,
        tone: 'neutral',
        link: { section: 'ideation' },
      },
    ];
  });

  protected readonly bugShares = computed<ShareSegment[]>(() =>
    (
      [
        ['open', 'bad'],
        ['in_progress', 'active'],
        ['fixed', 'ok'],
        ['wontfix', 'neutral'],
        ['rejected', 'neutral'],
      ] as const
    ).map(([status, tone]) => ({
      label: statusLabel(status),
      value: this.data().bugs.filter((bug) => bug.status === status).length,
      tone,
      link: { section: 'bugs', filters: { status: [statusLabel(status)] } },
    })),
  );

  protected readonly severityShares = computed<ShareSegment[]>(() => {
    const open = this.data().bugs.filter((bug) => bug.status === 'open' || bug.status === 'in_progress');
    return (
      [
        ['critical', 'bad'],
        ['high', 'warn'],
        ['medium', 'wait'],
        ['low', 'neutral'],
      ] as const
    ).map(([severity, tone]) => ({
      label: severityLabel(severity),
      value: open.filter((bug) => bug.severity === severity).length,
      tone,
      link: {
        section: 'bugs',
        filters: { severity: [severityLabel(severity)], status: [statusLabel('open'), statusLabel('in_progress')] },
      },
    }));
  });

  /** Offene Aufträge nach Priorität und nach Kategorie. */
  protected readonly priorityShares = computed<ShareSegment[]>(() => {
    const open = this.data().development.filter((item) => !isFinished(item.status));
    return (
      [
        ['high', 'bad'],
        ['medium', 'wait'],
        ['low', 'neutral'],
      ] as const
    ).map(([priority, tone]) => ({
      label: priorityLabel(priority),
      value: open.filter((item) => item.priority === priority).length,
      tone,
      link: { section: 'development', filters: { priority: [priorityLabel(priority)] } },
    }));
  });

  protected readonly categoryShares = computed<ShareSegment[]>(() => {
    const tones = ['info', 'active', 'ok', 'wait', 'plain', 'neutral'];
    const keys = [...CATEGORIES, null];
    return keys.map((category, index) => ({
      label: categoryLabel(category),
      value: this.data().development.filter((item) => (item.category ?? null) === category).length,
      tone: tones[index] ?? 'neutral',
      link: { section: 'development', filters: { category: [categoryLabel(category)] } },
    }));
  });

  /** Letzte Testläufe: bestanden, fehlgeschlagen, laufend. */
  protected readonly testShares = computed<ShareSegment[]>(() => {
    const runs = this.data().runs.slice(0, RECENT_RUNS);
    return (
      [
        ['passed', 'ok'],
        ['failed', 'bad'],
        ['running', 'active'],
      ] as const
    ).map(([status, tone]) => ({
      label: statusLabel(status),
      value: runs.filter((run) => run.status === status).length,
      tone,
      link: { section: 'runs', filters: { status: [statusLabel(status)] } },
    }));
  });

  protected readonly agentShares = computed<ShareSegment[]>(() => {
    const agents = this.data().stats?.agents ?? [];
    const sum = (key: 'passed' | 'failed' | 'skipped') => agents.reduce((total, agent) => total + agent[key], 0);
    return [
      { label: 'Bestanden', value: sum('passed'), tone: 'ok', link: { section: 'agents' } },
      { label: 'Fehlgeschlagen', value: sum('failed'), tone: 'bad', link: { section: 'agents' } },
      { label: 'Übersprungen', value: sum('skipped'), tone: 'neutral', link: { section: 'agents' } },
    ];
  });

  /** Je Agent ein Balken; Klick öffnet den Agent. */
  protected readonly agentRows = computed(() =>
    (this.data().stats?.agents ?? []).map((row) => {
      const agent = this.data().agents.find((entry) => entry.name === row.agent);
      const link = agent
        ? { section: 'agents', action: () => void this.agentActivity.show(agent.id) }
        : { section: 'agents' };
      return {
        name: row.agent,
        link,
        segments: [
          { label: 'Bestanden', value: row.passed, tone: 'ok', link },
          { label: 'Fehlgeschlagen', value: row.failed, tone: 'bad', link },
          { label: 'Übersprungen', value: row.skipped, tone: 'neutral', link },
        ] satisfies ShareSegment[],
      };
    }),
  );

  /** Je Sprint ein Balken mit den Aufträgen nach Status (neueste Sprints zuerst, max. 8). */
  protected readonly sprintRows = computed(() =>
    this.data()
      .sprints.slice(0, 8)
      .map((sprint) => ({
        sprint,
        segments: this.orderSegments(
          this.data().development.filter((item) => item.sprintId === sprint.id),
          sprint.name,
        ),
      })),
  );

  protected readonly legend = ORDER_STATUSES.map((status) => ({
    label: statusLabel(status),
    tone: ORDER_TONES[status]!,
  }));

  private orderSegments(items: DevelopmentItem[], sprint?: string): ShareSegment[] {
    return ORDER_STATUSES.map((status) => {
      const filters: Record<string, string[]> = { status: [statusLabel(status)] };
      if (sprint) filters['sprint'] = [sprint];
      return {
        label: statusLabel(status),
        value: items.filter((item) => item.status === status).length,
        tone: ORDER_TONES[status]!,
        // Blockierte Aufträge warten auf dich und stehen unter „Aktionen“.
        link:
          status === 'blocked'
            ? { section: 'actions' }
            : { section: 'development', filters, anchor: status === 'done' ? 'done-orders' : undefined },
      };
    });
  }

  protected openRuns(status: string): void {
    this.store.navigate('runs', { filters: { status: [statusLabel(status)] } });
  }

  protected dateLabel(value: string): string {
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime())
      ? value
      : date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  }

  protected barWidth(value: number, maximum: number): number {
    return maximum ? Math.max(0, Math.min(100, (value / maximum) * 100)) : 0;
  }
}
