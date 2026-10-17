import { AgentOutputPipe } from '../../shared/agent-output.pipe.js';
import { NgClass } from '@angular/common';
import { Component, inject } from '@angular/core';
import { ProjectStore } from '../../core/project-store.js';
import { DateTimePipe, DurationPipe, StatusClassPipe, StatusLabelPipe } from '../../shared/pipes.js';

@Component({
  selector: 'app-runs',
  standalone: true,
  imports: [NgClass, AgentOutputPipe, DateTimePipe, DurationPipe, StatusClassPipe, StatusLabelPipe],
  templateUrl: './runs.component.html',
  host: { style: 'display: contents' },
})
export class RunsComponent {
  protected readonly store = inject(ProjectStore);
  protected readonly data = this.store.data;
}
