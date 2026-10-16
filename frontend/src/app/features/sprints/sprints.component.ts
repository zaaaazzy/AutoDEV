import { NgClass } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import type { Agent, DevelopmentItem, RunStep, Sprint, SprintReport } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { OrderService } from '../development/order.service.js';
import { branchNode, commitNode, type GitNode, GitTreeComponent } from '../../shared/git-tree.component.js';
import { StepResultComponent } from '../../shared/step-result.component.js';
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

export interface WorkflowRow {
  key: string;
  name: string;
  step: RunStep | undefined;
}

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
    StepResultComponent,
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
    const steps = this.data()
      .agentRuns.filter((run) => run.developmentId === item.id)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .flatMap((run) => run.steps);
    const latest = (agent: Agent): RunStep | undefined => steps.filter((step) => step.agentId === agent.id).at(-1);
    const phases = ['pre_task', 'while_task', 'after_task'];
    const agents = this.data()
      .agents.filter(
        (agent) =>
          agent.enabled &&
          !(agent.role === 'author' && item.ideationId) &&
          !(agent.role === 'bug_reviewer' && item.risks?.trim()),
      )
      .sort(
        (left, right) => phases.indexOf(left.phase) - phases.indexOf(right.phase) || left.position - right.position,
      );
    const known = new Set(agents.map((agent) => agent.id));
    const rows: WorkflowRow[] = agents.map((agent) => ({
      key: agent.id,
      name: agent.name,
      step: latest(agent),
    }));
    for (const step of steps) {
      if (step.agentId && known.has(step.agentId)) continue;
      rows.push({ key: `${step.runId}-${step.position}`, name: step.agentName || 'Agent', step });
    }
    return rows;
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
    return this.data().development.filter((item) => item.sprintId === sprintId);
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
      action === 'push' ? 'Git Push wird ausgeführt.' : 'Git Download wird ausgeführt.',
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
