import { NgClass } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import type { Bug, BugStatus, Sprint } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import type { FormValues } from '../../shared/forms.js';
import {
  type DataColumn,
  DataCellDirective,
  DataDetailDirective,
  DataTableComponent,
} from '../../shared/data-table/data-table.component.js';
import { formatIsoDate } from '../../shared/format.js';
import { severityLabel, statusLabel } from '../../shared/labels.js';
import { MarkdownPipe } from '../../shared/markdown.pipe.js';
import { SeverityLabelPipe, ShortTextPipe, StatusClassPipe, StatusLabelPipe } from '../../shared/pipes.js';

const SEVERITY_RANK = ['low', 'medium', 'high', 'critical'];
const BUG_STATUS_RANK = ['open', 'in_progress', 'fixed', 'wontfix'];

@Component({
  selector: 'app-bugs',
  standalone: true,
  imports: [
    NgClass,
    FormsModule,
    DataTableComponent,
    DataCellDirective,
    DataDetailDirective,
    MarkdownPipe,
    SeverityLabelPipe,
    ShortTextPipe,
    StatusClassPipe,
    StatusLabelPipe,
  ],
  templateUrl: './bugs.component.html',
  host: { style: 'display: contents' },
})
export class BugsComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  protected readonly data = this.store.data;
  protected readonly busy = this.store.busy;
  protected readonly bugStatuses: BugStatus[] = ['open', 'in_progress', 'fixed', 'wontfix'];
  protected readonly openBug = signal<string | null>(null);
  protected readonly bugId = (bug: Bug): string => bug.id;
  protected readonly bugColumns: DataColumn<Bug>[] = [
    { id: 'title', header: 'Titel', value: (bug) => bug.title, filter: 'text', className: 'title-cell' },
    {
      id: 'status',
      header: 'Status',
      value: (bug) => statusLabel(bug.status),
      sortValue: (bug) => BUG_STATUS_RANK.indexOf(bug.status),
    },
    {
      id: 'severity',
      header: 'Schweregrad',
      value: (bug) => severityLabel(bug.severity),
      sortValue: (bug) => SEVERITY_RANK.indexOf(bug.severity),
    },
    { id: 'source', header: 'Quelle', value: (bug) => (bug.source === 'agent' ? 'Agent' : 'Manuell') },
    {
      id: 'sprint',
      header: 'Sprint',
      value: (bug) => this.data().sprints.find((sprint) => sprint.id === bug.sprintId)?.name ?? 'Kein Sprint',
    },
    {
      id: 'createdAt',
      header: 'Erstellt',
      value: (bug) => formatIsoDate(bug.createdAt),
      sortValue: (bug) => bug.createdAt,
    },
  ];
  protected bugForm = { title: '', description: '', severity: 'medium', sprintId: '' };

  protected toggleBug(id: string): void {
    this.openBug.update((current) => (current === id ? null : id));
  }

  protected availableSprints(): Sprint[] {
    return this.data().sprints.filter((sprint) => sprint.status !== 'completed');
  }

  protected async createBug(): Promise<void> {
    const body = { ...this.bugForm, sprintId: this.bugForm.sprintId || null };
    await this.store.perform(async () => {
      await this.api.post(`${this.api.projectPath(this.store.activeProject())}/bugs`, body);
      this.bugForm = { title: '', description: '', severity: 'medium', sprintId: '' };
      this.store.showCreate.set(false);
    }, 'Bug wurde gemeldet.');
  }

  protected async saveBug(bug: Bug, values: FormValues): Promise<void> {
    await this.store.perform(
      () =>
        this.api.patch(`/api/bugs/${encodeURIComponent(bug.id)}`, {
          title: String(values['title'] ?? ''),
          description: String(values['description'] ?? ''),
          severity: values['severity'],
          sprintId: values['sprintId'] || null,
          fixNotes: String(values['fixNotes'] ?? ''),
        }),
      'Bug wurde gespeichert.',
    );
  }

  protected async updateBug(id: string, values: Partial<Bug>): Promise<void> {
    await this.store.perform(() => this.api.patch(`/api/bugs/${encodeURIComponent(id)}`, values), 'Bug aktualisiert.');
  }

  protected async deleteBug(id: string): Promise<void> {
    if (!globalThis.confirm('Bug löschen?')) return;
    await this.store.perform(() => this.api.delete(`/api/bugs/${encodeURIComponent(id)}`), 'Bug gelöscht.');
  }
}
