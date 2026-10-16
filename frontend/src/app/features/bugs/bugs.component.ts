import { NgClass } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import type { Bug, BugStatus, Sprint } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import type { FormValues } from '../../shared/forms.js';
import { DateTimePipe, SeverityLabelPipe, StatusClassPipe, StatusLabelPipe } from '../../shared/pipes.js';

@Component({
  selector: 'app-bugs',
  standalone: true,
  imports: [NgClass, FormsModule, DateTimePipe, SeverityLabelPipe, StatusClassPipe, StatusLabelPipe],
  templateUrl: './bugs.component.html',
  host: { style: 'display: contents' },
})
export class BugsComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  protected readonly data = this.store.data;
  protected readonly busy = this.store.busy;
  protected readonly bugStatuses: BugStatus[] = ['open', 'in_progress', 'fixed', 'wontfix'];
  protected readonly bugFilter = signal<'all' | BugStatus>('all');
  protected bugForm = { title: '', description: '', severity: 'medium', sprintId: '' };

  protected readonly visibleBugs = computed<Bug[]>(() => {
    const filter = this.bugFilter();
    return this.data().bugs.filter((bug) => filter === 'all' || bug.status === filter);
  });

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
    await this.store.perform(() => this.api.patch(`/api/bugs/${encodeURIComponent(bug.id)}`, {
      title: String(values['title'] ?? ''),
      description: String(values['description'] ?? ''),
      severity: values['severity'],
      sprintId: values['sprintId'] || null,
      fixNotes: String(values['fixNotes'] ?? ''),
    }), 'Bug wurde gespeichert.');
  }

  protected async updateBug(id: string, values: Partial<Bug>): Promise<void> {
    await this.store.perform(() => this.api.patch(`/api/bugs/${encodeURIComponent(id)}`, values), 'Bug aktualisiert.');
  }

  protected async deleteBug(id: string): Promise<void> {
    if (!globalThis.confirm('Bug löschen?')) return;
    await this.store.perform(() => this.api.delete(`/api/bugs/${encodeURIComponent(id)}`), 'Bug gelöscht.');
  }
}
