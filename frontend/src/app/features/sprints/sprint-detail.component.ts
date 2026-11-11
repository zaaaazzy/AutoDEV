import { NgClass } from '@angular/common';
import { Component, computed, inject, input, signal } from '@angular/core';
import { GitGuardService } from '../../core/git-guard.service.js';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import { AuthService } from '../../core/auth.service.js';
import type { DevelopmentItem, Sprint, SprintReport } from '../../core/models.js';
import { DEVELOPMENT_STATUS, SPRINT_STATUS } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { USD_PER_MILLION_TOKENS } from '../../shared/format.js';
import { ciLabel } from '../../shared/labels.js';
import { branchNode, commitNode, type GitNode, GitTreeComponent } from '../../shared/git-tree.component.js';
import { NavIconComponent } from '../../shared/nav-icon.component.js';
import {
  DurationPipe,
  HoursPipe,
  IsoDatePipe,
  StatusClassPipe,
  StatusLabelPipe,
  TokensPipe,
  UsdPipe,
} from '../../shared/pipes.js';
import { exclusive, sprintButtons } from './sprint-actions.js';
import { SprintOrdersComponent } from './sprint-orders.component.js';
import { sprintReviewable } from './review-launch.js';
import { orderSprint } from './sprint-phases.js';
import { SprintReviewComponent } from './sprint-review.component.js';
import { GitAlertComponent } from '../../shared/git-alert.component.js';
import { defined } from '../../../../../src/core/defined.js';

/** Ein Sprint im Detail: Hinweise zum Go, Aufträge, Ziel, Bericht, Kennzahlen, Git-Stand und Aktionen. */
@Component({
  selector: 'app-sprint-detail',
  standalone: true,
  imports: [
    GitAlertComponent,
    NgClass,
    FormsModule,
    GitTreeComponent,
    NavIconComponent,
    SprintOrdersComponent,
    SprintReviewComponent,
    DurationPipe,
    HoursPipe,
    IsoDatePipe,
    StatusClassPipe,
    StatusLabelPipe,
    TokensPipe,
    UsdPipe,
  ],
  templateUrl: './sprint-detail.component.html',
})
export class SprintDetailComponent {
  private readonly api = inject(ApiService);
  private readonly gitGuard = inject(GitGuardService);
  private readonly auth = inject(AuthService);
  protected readonly store = inject(ProjectStore);
  /** Sprint-Aktion ab dem Klick bis zur Antwort (auch während der Rückfrage): sperrt die Knöpfe gegen Doppelklick. */
  private readonly acting = signal(false);
  protected readonly busy = computed(() => this.store.busy() || this.acting());
  protected readonly usdRate = USD_PER_MILLION_TOKENS;
  readonly sprintInput = input.required<Sprint>({ alias: 'sprint' });
  protected readonly editingId = signal<string | null>(null);
  protected readonly reviewable = sprintReviewable;

  /** Sichtbare Knöpfe nach denselben Regeln wie der Server (src/core/sprint-rules.ts) und nach Rolle. */
  protected readonly buttons = computed(() =>
    sprintButtons(this.sprintInput(), this.store.data().sprints, this.store.data().development, this.can),
  );
  private readonly can = (role: 'plan' | 'run'): boolean => this.auth.can(role);

  // Kennzahlen als computed aus dem Input und den Store-Daten (beide werden ersetzt, nie verändert): nur bei
  // einer Änderung neu berechnet, nicht bei jeder Änderungsprüfung.
  protected readonly report = computed<SprintReport | undefined>(() =>
    this.store.data().reports.find((report) => report.sprintId === this.sprintInput().id),
  );

  protected readonly sprintItems = computed<DevelopmentItem[]>(() => {
    const sprintId = this.sprintInput().id;
    return orderSprint(this.store.data().development.filter((item) => item.sprintId === sprintId));
  });

  protected readonly sprintProgress = computed(() => {
    const orders = this.sprintItems();
    const done = orders.filter((item) => item.status === DEVELOPMENT_STATUS.done).length;
    return `${done} / ${orders.length} Aufträge erledigt`;
  });

  protected readonly sprintEstimate = computed<number | null>(() => {
    const efforts = this.sprintItems().flatMap((item) =>
      typeof item.effortHours === 'number' ? [item.effortHours] : [],
    );
    return efforts.length ? efforts.reduce((sum, hours) => sum + hours, 0) : null;
  });

  protected readonly sprintTokensEstimate = computed<number | null>(() => {
    const tokens = this.sprintItems().flatMap((item) =>
      item.tokenEstimate === null || item.tokenEstimate === undefined ? [] : [Number(item.tokenEstimate)],
    );
    return tokens.length ? tokens.reduce((sum, value) => sum + value, 0) : null;
  });

  /** Schritte aller Agent-Läufe zu den Aufträgen des Sprints. */
  private readonly sprintSteps = computed(() => {
    const ids = new Set(this.sprintItems().map((item) => item.id));
    return this.store
      .data()
      .agentRuns.filter((run) => run.developmentId && ids.has(run.developmentId))
      .flatMap((run) => run.steps);
  });

  protected readonly sprintTokensSpent = computed<number | null>(
    () => this.sprintSteps().reduce((sum, step) => sum + Number(step.tokens ?? 0), 0) || null,
  );

  protected readonly sprintSpent = computed<number | null>(
    () => this.sprintSteps().reduce((sum, step) => sum + (step.durationMs ?? 0), 0) || null,
  );

  protected readonly ciLabel = computed(() => ciLabel(this.sprintInput().ciStatus));

  protected readonly gitNodes = computed<GitNode[]>(() => {
    const sprint = this.sprintInput();
    const orders = this.sprintItems().map((item): GitNode => ({ kind: 'step', text: item.title }));
    return [branchNode(sprint), ...orders, commitNode(sprint)];
  });

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

  protected async updateSprint(id: string, values: Partial<Sprint>): Promise<void> {
    await exclusive(this.acting, () =>
      this.store.perform(
        () => this.api.patch(`/api/sprints/${encodeURIComponent(id)}`, values),
        'Sprint aktualisiert.',
      ),
    );
  }

  /** Sperrender Git-Befund am Projektordner: Live schalten fragt dann mit Warnung nach. */
  protected readonly gitBlocksLive = computed(() => this.gitGuard.blocking('go_live').length > 0);

  /** Go zum Sprint: Tests, CI, Merge nach main, dann zieht der Projektordner nach und es wird deployt. */
  protected async goLive(sprint: Sprint): Promise<void> {
    await exclusive(this.acting, async () => {
      const answer = await this.gitGuard.confirmAction(
        'go_live',
        {
          title: 'Sprint live schalten?',
          message: `„${sprint.name}“: Tests und CI laufen, danach wird der Sprint nach main gemergt, der Projektordner nachgezogen und deployt.`,
          details: sprint.reviewReadyAt ? [] : ['Achtung: Es sind noch nicht alle Aufträge durch.'],
          confirmLabel: 'Live schalten',
          withoutComment: true,
        },
        'Trotzdem live schalten',
      );
      if (!answer) return;
      await this.store.perform(
        () => this.api.patch(`/api/sprints/${encodeURIComponent(sprint.id)}`, { status: 'completed', ...answer.body }),
        'Wird live geschaltet – Tests, CI und Merge laufen im Hintergrund.',
      );
    });
  }

  /** Sprint starten bzw. wieder öffnen: Die Agents arbeiten danach in ihrem Ordner – der muss sauber sein. */
  protected async startSprint(sprint: Sprint): Promise<void> {
    await exclusive(this.acting, async () => {
      const reopen = sprint.status === SPRINT_STATUS.completed;
      const answer = await this.gitGuard.confirmAction(
        'sprint_start',
        {
          title: reopen ? 'Sprint wieder öffnen?' : 'Sprint starten?',
          message: reopen
            ? `„${sprint.name}“ wird wieder aktiv; offene Aufträge laufen weiter.`
            : `„${sprint.name}“ startet; die Agents arbeiten die Aufträge der Reihe nach ab.`,
          confirmLabel: reopen ? 'Wieder öffnen' : 'Sprint starten',
          withoutComment: true,
        },
        reopen ? 'Trotzdem wieder öffnen' : 'Trotzdem starten',
      );
      if (!answer) return;
      await this.store.perform(
        () => this.api.patch(`/api/sprints/${encodeURIComponent(sprint.id)}`, { status: 'active', ...answer.body }),
        reopen ? 'Sprint ist wieder offen.' : 'Sprint gestartet.',
      );
    });
  }

  /** Abbrechen: laufende Agents enden, offene Aufträge gehen zurück ins Backlog (unter „Aktionen“ wieder einplanbar). */
  protected async cancelSprint(sprint: Sprint): Promise<void> {
    if (
      !globalThis.confirm(
        `„${sprint.name}“ abbrechen?\n\nLaufende Agents werden beendet. Offene Aufträge gehen zurück ins Backlog und lassen sich unter „Aktionen“ wieder einplanen. Erledigtes bleibt erhalten, gemergt wird nichts.`,
      )
    )
      return;
    await exclusive(this.acting, () =>
      this.store.perform(
        () => this.api.patch(`/api/sprints/${encodeURIComponent(sprint.id)}`, { status: 'cancelled' }),
        'Sprint abgebrochen.',
      ),
    );
  }

  protected async deleteSprint(id: string): Promise<void> {
    if (!globalThis.confirm('Sprint löschen? Die Aufträge bleiben im Backlog erhalten.')) return;
    await exclusive(this.acting, () =>
      this.store.perform(() => this.api.delete(`/api/sprints/${encodeURIComponent(id)}`), 'Sprint gelöscht.'),
    );
  }

  /** Pull Request des Sprints (PR-Modus); nur echte GitHub-PR-Links werden verlinkt. */
  protected pullRequest(sprint: Sprint): { url: string; number: string } | null {
    const url = sprint.prUrl ?? '';
    const match = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)$/.exec(url);
    return match ? { url, number: defined(match[1]) } : null;
  }

  protected gitBusy(sprint: Sprint): boolean {
    return sprint.gitSync === 'pending' || sprint.gitSync === 'running';
  }

  protected async pauseSprint(id: string): Promise<void> {
    await exclusive(this.acting, () =>
      this.store.perform(
        () => this.api.post(`/api/sprints/${encodeURIComponent(id)}/pause`),
        'Sprint pausiert: Laufende Agents beenden ihren Schritt, danach startet nichts Neues.',
      ),
    );
  }

  protected async resumeSprint(id: string): Promise<void> {
    await exclusive(this.acting, () =>
      this.store.perform(() => this.api.post(`/api/sprints/${encodeURIComponent(id)}/resume`), 'Sprint läuft weiter.'),
    );
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
