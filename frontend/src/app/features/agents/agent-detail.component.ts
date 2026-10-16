import { StepResultComponent } from '../../shared/step-result.component.js';
import { NgClass } from '@angular/common';
import { Component, inject, input } from '@angular/core';
import { AgentActivityService } from '../../core/agent-activity.service.js';
import type { Agent } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { DateTimePipe, PriorityLabelPipe, StatusClassPipe, StatusLabelPipe } from '../../shared/pipes.js';
import { roleLabel } from './agent-options.js';

@Component({
  selector: 'app-agent-detail',
  standalone: true,
  imports: [NgClass, DateTimePipe, PriorityLabelPipe, StatusClassPipe, StatusLabelPipe, StepResultComponent],
  templateUrl: './agent-detail.component.html',
  host: { style: 'display: contents' },
})
export class AgentDetailComponent {
  private readonly store = inject(ProjectStore);
  private readonly activity = inject(AgentActivityService);
  protected readonly agentActivityLoading = this.activity.loading;
  protected readonly agentActive = this.activity.active;
  protected readonly agentDone = this.activity.done;
  protected readonly agentUpcoming = this.activity.upcoming;
  protected readonly roleLabel = roleLabel;

  readonly selected = input.required<Agent>();

  protected closeAgent(): void {
    this.store.openAgent.set(null);
  }
}
