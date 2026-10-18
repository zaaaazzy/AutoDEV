import { NgClass } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import type { DevelopmentItem, Sprint, SprintReport } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { OrderService } from '../development/order.service.js';
import { branchNode, commitNode, type GitNode, GitTreeComponent } from '../../shared/git-tree.component.js';
import { buildWorkflow, type WorkflowRow } from '../../shared/workflow.js';
import {
  type DataColumn,
  DataCellDirective,
  DataDetailDirective,
  DataTableComponent,
} from '../../shared/data-table/data-table.component.js';
import { formatIsoDate } from '../../shared/format.js';
import { combinedCategory, statusLabel } from '../../shared/labels.js';
import { categoryColumn } from '../../shared/data-table/columns.js';
import { AgentWorkflowComponent } from '../../shared/agent-workflow.component.js';
import { NavIconComponent } from '../../shared/nav-icon.component.js';
import { USD_PER_MILLION_TOKENS } from '../../shared/format.js';
import {
  DurationPipe,
  HoursPipe,
  IsoDatePipe,
  StatusClassPipe,
  StatusLabelPipe,
  TokensPipe,
  UsdPipe,
} from '../../shared/pipes.js';

const SPRINT_STATUS_RANK = ['active', 'planned', 'completed'];

@Component({
  selector: 'app-sprints',
  standalone: true,
  imports: [
    NgClass,
    FormsModule,
    DurationPipe,
    GitTreeComponent,
    HoursPipe,
    IsoDatePipe,
    NavIconComponent,
    StatusClassPipe,
    StatusLabelPipe,
    AgentWorkflowComponent,
    DataTableComponent,
    DataCellDirective,
    DataDetailDirective,
    TokensPipe,
    UsdPipe,
  ],
  templateUrl: './sprints.component.html',
  host: { style: 'display: contents' },
})
export class SprintsComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  private readonly orders = inject(OrderService);
  protected readonly data = this.store.data;
  protected readonly busy = this.store.busy;
  protected readonly usdRate = USD_PER_MILLION_TOKENS;
  protected sprintForm = { name: '', goal: '', startDate: '', endDate: '' };
  protected readonly editingId = signal<string | null>(null);
  protected readonly openSprintItems = signal<ReadonlySet<string>>(new Set());
  protected readonly openSprint = signal<string | null>(
    this.store.data().sprints.find((sprint) => sprint.status === 'active')?.id ?? null,
  );
  protected readonly sprintId = (sprint: Sprint): string => sprint.id;
  protected readonly sprintColumns: DataColumn<Sprint>[] = [
    { id: 'name', header: 'Sprint', value: (sprint) => sprint.name, filter: 'text', className: 'title-cell' },
    {
      id: 'status',
      header: 'Status',
      value: (sprint) => statusLabel(sprint.status),
      sortValue: (sprint) => SPRINT_STATUS_RANK.indexOf(sprint.status),
    },
    categoryColumn<Sprint>((sprint) =>
      combinedCategory(
        this.data()
          .development.filter((item) => item.sprintId === sprint.id)
          .map((item) => item.category),
      ),
    ),
    {
      id: 'start',
      header: 'Start',
      value: (sprint) => (sprint.startDate ? formatIsoDate(sprint.startDate) : ''),
      sortValue: (sprint) => sprint.startDate ?? '',
      filter: false,
    },
    {
      id: 'end',
      header: 'Ende',
      value: (sprint) => (sprint.endDate ? formatIsoDate(sprint.endDate) : ''),
      sortValue: (sprint) => sprint.endDate ?? '',
      filter: false,
    },
    {
      id: 'progress',
      header: 'Aufträge',
      value: (sprint) => `${this.sprintCounts(sprint.id).done}/${this.sprintCounts(sprint.id).total}`,
      sortValue: (sprint) => this.sprintCounts(sprint.id).done,
      filter: false,
    },
  ];

  protected sprintCounts(sprintId: string): { done: number; total: number } {
    const orders = this.data().development.filter((item) => item.sprintId === sprintId);
    return { done: orders.filter((item) => item.status === 'done').length, total: orders.length };
  }

  protected toggleSprint(id: string): void {
    this.openSprint.update((current) => (current === id ? null : id));
  }

  protected removeFromSprint(item: DevelopmentItem): Promise<void> {
    return this.orders.removeFromSprint(item);
  }

  protected retry(item: DevelopmentItem): Promise<void> {
    return this.orders.retry(item);
  }

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

  /** Workflow einer Aufgabe: alle Agents in Laufreihenfolge, jeweils mit dem neuesten Schritt (oder „Ausstehend“). */
  protected workflow(item: DevelopmentItem): WorkflowRow[] {
    return buildWorkflow(this.data(), item);
  }

  /** Statuszeile der Aufgabe: aktueller Status und der laufende bzw. zuletzt gescheiterte Agent. */
  protected workflowSummary(item: DevelopmentItem, rows: WorkflowRow[]): string {
    const running = rows.find((row) => row.step?.status === 'running');
    const failed = rows.find((row) => row.step?.status === 'failed');
    const done = rows.filter((row) => row.step?.status === 'passed').length;
    const progress = `${done} von ${rows.length} Agents abgeschlossen`;
    if (running) return `Läuft: ${running.name} · ${progress}`;
    if (item.status === 'blocked' && failed) return `Blockiert bei: ${failed.name} · ${progress}`;
    if (item.status === 'done') return `Alle Agents abgeschlossen`;
    if (item.status === 'planned') return `Wartet auf den Worker · ${progress}`;
    return progress;
  }

  protected sprintItems(sprintId: string): DevelopmentItem[] {
    const rank = (status: string): number => {
      const order = ['in_progress', 'planned', 'backlog', 'blocked', 'done'];
      const index = order.indexOf(status);
      return index < 0 ? order.length : index;
    };
    return this.data()
      .development.filter((item) => item.sprintId === sprintId)
      .sort((left, right) => rank(left.status) - rank(right.status));
  }

  protected sprintProgress(sprintId: string): string {
    const orders = this.sprintItems(sprintId);
    const done = orders.filter((item) => item.status === 'done').length;
    return `${done} / ${orders.length} Aufträge erledigt`;
  }

  protected sprintEstimate(sprintId: string): number | null {
    const efforts = this.sprintItems(sprintId).flatMap((item) =>
      typeof item.effortHours === 'number' ? [item.effortHours] : [],
    );
    return efforts.length ? efforts.reduce((sum, hours) => sum + hours, 0) : null;
  }

  protected sprintTokensEstimate(sprintId: string): number | null {
    const tokens = this.sprintItems(sprintId).flatMap((item) =>
      item.tokenEstimate === null || item.tokenEstimate === undefined ? [] : [Number(item.tokenEstimate)],
    );
    return tokens.length ? tokens.reduce((sum, value) => sum + value, 0) : null;
  }

  protected sprintTokensSpent(sprintId: string): number | null {
    const ids = new Set(this.sprintItems(sprintId).map((item) => item.id));
    const total = this.data()
      .agentRuns.filter((run) => run.developmentId && ids.has(run.developmentId))
      .flatMap((run) => run.steps)
      .reduce((sum, step) => sum + Number(step.tokens ?? 0), 0);
    return total || null;
  }

  protected sprintSpent(sprintId: string): number | null {
    const ids = new Set(this.sprintItems(sprintId).map((item) => item.id));
    const total = this.data()
      .agentRuns.filter((run) => run.developmentId && ids.has(run.developmentId))
      .flatMap((run) => run.steps)
      .reduce((sum, step) => sum + (step.durationMs ?? 0), 0);
    return total || null;
  }

  protected async saveSprint(id: string, values: Partial<Sprint>): Promise<void> {
    await this.updateSprint(id, values);
    this.editingId.set(null);
  }

  /** ZIP des Sprint-Stands direkt von GitHub (Commit, sonst Branch); ändert nichts am lokalen Repository. */
  protected zipUrl(sprint: Sprint): string | null {
    const base = this.githubBase();
    if (!base) return null;
    const ref = sprint.gitCommit || (sprint.gitBranch ? `refs/heads/${sprint.gitBranch}` : 'HEAD');
    return `${base}/archive/${ref.split('/').map(encodeURIComponent).join('/')}.zip`;
  }

  protected githubBase(): string | null {
    const remote = this.store.currentProject()?.gitRemote?.trim();
    const match = remote?.match(
      /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+\/[^\s]+?)(?:\.git)?\/?$/,
    );
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
    await this.store.perform(
      () => this.api.patch(`/api/sprints/${encodeURIComponent(id)}`, values),
      'Sprint aktualisiert.',
    );
  }

  protected async deleteSprint(id: string): Promise<void> {
    if (!globalThis.confirm('Sprint löschen? Die Aufträge bleiben im Backlog erhalten.')) return;
    await this.store.perform(() => this.api.delete(`/api/sprints/${encodeURIComponent(id)}`), 'Sprint gelöscht.');
  }

  protected gitBusy(sprint: Sprint): boolean {
    return sprint.gitSync === 'pending' || sprint.gitSync === 'running';
  }

  protected gitNodes(sprint: Sprint): GitNode[] {
    const orders = this.sprintItems(sprint.id).map((item): GitNode => ({ kind: 'step', text: item.title }));
    return [branchNode(sprint), ...orders, commitNode(sprint)];
  }

  protected async syncGit(id: string, action: 'push' | 'pull'): Promise<void> {
    await this.store.perform(
      () => this.api.post(`/api/sprints/${encodeURIComponent(id)}/git-sync`, { action }),
      action === 'push' ? 'Git Push wird ausgeführt.' : 'Git Pull wird ausgeführt.',
    );
  }

  protected async refreshReport(id: string): Promise<void> {
    await this.store.perform(
      () => this.api.post(`/api/sprints/${encodeURIComponent(id)}/report`),
      'Sprintbericht aktualisiert.',
    );
  }

  protected async saveReportNotes(id: string, notes: string): Promise<void> {
    await this.store.perform(
      () => this.api.patch(`/api/sprints/${encodeURIComponent(id)}/report`, { notes }),
      'Sprintbericht-Notizen gespeichert.',
    );
  }
}
