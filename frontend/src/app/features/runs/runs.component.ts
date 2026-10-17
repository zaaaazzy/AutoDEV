import { AgentOutputPipe } from '../../shared/agent-output.pipe.js';
import { NgClass } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import type { TestRun } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import {
  type DataColumn,
  DataCellDirective,
  DataDetailDirective,
  DataTableComponent,
} from '../../shared/data-table/data-table.component.js';
import { statusLabel } from '../../shared/labels.js';
import { DurationPipe, StatusClassPipe, StatusLabelPipe } from '../../shared/pipes.js';

@Component({
  selector: 'app-runs',
  standalone: true,
  imports: [
    NgClass,
    AgentOutputPipe,
    DataTableComponent,
    DataCellDirective,
    DataDetailDirective,
    DurationPipe,
    StatusClassPipe,
    StatusLabelPipe,
  ],
  templateUrl: './runs.component.html',
  host: { style: 'display: contents' },
})
export class RunsComponent {
  protected readonly store = inject(ProjectStore);
  protected readonly data = this.store.data;
  protected readonly openRun = signal<string | null>(null);
  protected readonly runId = (run: TestRun): string => run.id;
  protected readonly runColumns: DataColumn<TestRun>[] = [
    {
      id: 'startedAt',
      header: 'Gestartet',
      value: (run) => new Date(run.startedAt).toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' }),
      sortValue: (run) => run.startedAt,
      filter: false,
      className: 'title-cell',
    },
    { id: 'status', header: 'Status', value: (run) => statusLabel(run.status) },
    { id: 'trigger', header: 'Auslöser', value: (run) => (run.trigger === 'ci' ? 'CI' : 'Manuell') },
    { id: 'branch', header: 'Branch', value: (run) => run.branch || 'ohne Branch' },
    {
      id: 'commit',
      header: 'Commit',
      value: (run) => run.commitSha?.slice(0, 8) || '–',
      filter: 'text',
    },
    { id: 'steps', header: 'Schritte', value: (run) => run.steps.length, filter: false },
  ];
}
