import { NgClass } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import type { AgentRun, DevelopmentItem, Sprint, SprintReport } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { MarkdownPipe } from '../../shared/markdown.pipe.js';
import { StatusClassPipe, StatusLabelPipe } from '../../shared/pipes.js';

@Component({
  selector: 'app-sprints',
  standalone: true,
  imports: [NgClass, FormsModule, MarkdownPipe, StatusClassPipe, StatusLabelPipe],
  templateUrl: './sprints.component.html',
  host: { style: 'display: contents' },
})
export class SprintsComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  protected readonly data = this.store.data;
  protected readonly busy = this.store.busy;
  protected sprintForm = { name: '', goal: '', startDate: '', endDate: '' };
  protected readonly openSprintItems = signal<ReadonlySet<string>>(new Set());

  protected toggleSprintItem(id: string): void {
    this.openSprintItems.update((set) => {
      const next = new Set(set);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected reportFor(sprintId: string): SprintReport | undefined {
    return this.data().reports.find((report) => report.sprintId === sprintId);
  }

  protected sprintRun(itemId: string): AgentRun | undefined {
    return this.data().agentRuns.find((run) => run.developmentId === itemId);
  }

  protected sprintItems(sprintId: string): DevelopmentItem[] {
    return this.data().development.filter((item) => item.sprintId === sprintId);
  }

  protected sprintProgress(sprintId: string): string {
    const orders = this.sprintItems(sprintId);
    const done = orders.filter((item) => item.status === 'done').length;
    return `${done} / ${orders.length} Aufträge erledigt`;
  }

  protected githubBase(): string | null {
    const remote = this.store.currentProject()?.gitRemote?.trim();
    const match = remote?.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+\/[^\s]+?)(?:\.git)?\/?$/);
    return match ? `https://github.com/${match[1]}` : null;
  }

  protected async createSprint(): Promise<void> {
    const body = {
      name: this.sprintForm.name,
      goal: this.sprintForm.goal,
      startDate: this.sprintForm.startDate || null,
      endDate: this.sprintForm.endDate || null,
    };
    await this.store.perform(async () => {
      await this.api.post(`${this.api.projectPath(this.store.activeProject())}/sprints`, body);
      this.sprintForm = { name: '', goal: '', startDate: '', endDate: '' };
      this.store.showCreate.set(false);
    }, 'Sprint angelegt.');
  }

  protected async updateSprint(id: string, values: Partial<Sprint>): Promise<void> {
    await this.store.perform(() => this.api.patch(`/api/sprints/${encodeURIComponent(id)}`, values), 'Sprint aktualisiert.');
  }

  protected async deleteSprint(id: string): Promise<void> {
    if (!globalThis.confirm('Sprint löschen? Die Aufträge bleiben im Backlog erhalten.')) return;
    await this.store.perform(() => this.api.delete(`/api/sprints/${encodeURIComponent(id)}`), 'Sprint gelöscht.');
  }

  protected async retryGitSync(id: string): Promise<void> {
    await this.store.perform(() => this.api.post(`/api/sprints/${encodeURIComponent(id)}/git-sync`), 'Git-Sicherung wird erneut ausgeführt.');
  }

  protected async refreshReport(id: string): Promise<void> {
    await this.store.perform(() => this.api.post(`/api/sprints/${encodeURIComponent(id)}/report`), 'Sprintbericht aktualisiert.');
  }

  protected async saveReportNotes(id: string, notes: string): Promise<void> {
    await this.store.perform(() => this.api.patch(`/api/sprints/${encodeURIComponent(id)}/report`, { notes }), 'Sprintbericht-Notizen gespeichert.');
  }
}
