import { CoveragePanelComponent } from './coverage-panel.component.js';
import { NgClass } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { ProjectStore } from '../../core/project-store.js';
import { DEVELOPMENT_STATUSES } from '../../shared/labels.js';
import {
  DateTimePipe,
  HoursPipe,
  LocaleNumberPipe,
  SeverityLabelPipe,
  StatusClassPipe,
  StatusLabelPipe,
} from '../../shared/pipes.js';
import { AgentListComponent } from '../agents/agent-list.component.js';
import { ChatComponent } from '../chat/chat.component.js';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    NgClass,
    AgentListComponent,
    ChatComponent,
    CoveragePanelComponent,
    DateTimePipe,
    HoursPipe,
    LocaleNumberPipe,
    SeverityLabelPipe,
    StatusClassPipe,
    StatusLabelPipe,
  ],
  templateUrl: './dashboard.component.html',
  host: { style: 'display: contents' },
})
export class DashboardComponent {
  protected readonly store = inject(ProjectStore);
  protected readonly data = this.store.data;
  protected readonly worker = this.store.worker;
  protected readonly developmentStatuses = DEVELOPMENT_STATUSES;
  protected readonly severityLevels = ['critical', 'high', 'medium', 'low'];

  protected readonly activeSprint = computed(
    () => this.data().sprints.find((sprint) => sprint.status === 'active') ?? null,
  );
  protected readonly openIdeasCount = computed(
    () => this.data().ideas.filter((idea) => !['accepted', 'rejected'].includes(idea.status)).length,
  );
  protected readonly ratedIdeas = computed(() =>
    this.data().ideas.filter(
      (idea) =>
        !['accepted', 'rejected'].includes(idea.status) &&
        idea.benefit !== null &&
        idea.benefit !== undefined &&
        idea.cost !== null &&
        idea.cost !== undefined,
    ),
  );
  protected readonly orderTotal = computed(() =>
    Object.values(this.data().stats?.orders ?? {}).reduce((sum, count) => sum + count, 0),
  );
  protected readonly agentRuns = computed(() =>
    (this.data().stats?.agents ?? []).reduce((sum, agent) => sum + agent.passed + agent.failed, 0),
  );
  protected readonly agentFailures = computed(() =>
    (this.data().stats?.agents ?? []).reduce((sum, agent) => sum + agent.failed, 0),
  );
  protected readonly maxVelocity = computed(() =>
    Math.max(1, ...(this.data().stats?.velocity ?? []).map((sprint) => sprint.total)),
  );
  protected readonly maxAgentRuns = computed(() =>
    Math.max(1, ...(this.data().stats?.agents ?? []).map((agent) => agent.passed + agent.failed + agent.skipped)),
  );
  protected readonly maxSeverityCount = computed(() =>
    Math.max(1, ...Object.values(this.data().stats?.openBugsBySeverity ?? {})),
  );

  protected barWidth(value: number, maximum: number): number {
    return maximum ? Math.max(0, Math.min(100, (value / maximum) * 100)) : 0;
  }

  protected dateLabel(value: string): string {
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime())
      ? value
      : date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  }
}
