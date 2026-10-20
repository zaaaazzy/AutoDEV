import { PermissionGroupsSettingsComponent } from './permission-groups-settings.component.js';
import { Component, effect, inject, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ReviewSlotsSettingsComponent } from './review-slots-settings.component.js';
import { FolderPickerComponent } from '../../shared/folder-picker.component.js';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import type { AgentStatus, GithubMode, Project } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { NotificationSettingsComponent } from './notification-settings.component.js';
import { ProductionSettingsComponent } from './production-settings.component.js';
import { VisualSettingsComponent } from './visual-settings.component.js';
import { SecuritySettingsComponent } from './security-settings.component.js';
import { UsersSettingsComponent } from './users-settings.component.js';
import { BudgetSettingsComponent } from './budget-settings.component.js';
import { AuthService } from '../../core/auth.service.js';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [
    ReviewSlotsSettingsComponent,
    FolderPickerComponent,
    ProductionSettingsComponent,
    VisualSettingsComponent,
    PermissionGroupsSettingsComponent,
    DatePipe,
    FormsModule,
    NotificationSettingsComponent,
    SecuritySettingsComponent,
    UsersSettingsComponent,
    BudgetSettingsComponent,
  ],
  templateUrl: './settings.component.html',
  host: { style: 'display: contents' },
})
export class SettingsComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  protected readonly auth = inject(AuthService);
  protected readonly busy = this.store.busy;
  protected settings = {
    repository: '',
    testCommands: '',
    deployCommands: '',
    gitRemote: '',
    description: '',
    guidelines: '',
    definitionOfReady: '',
    definitionOfDone: '',
    autoBugfix: true,
    agentWorkspace: false,
    reviewMode: 'off' as 'off' | 'ui' | 'always',
    reviewCommand: '',
    restartAfterSprint: false,
    sprintMode: 'manual' as 'manual' | 'suggest' | 'autopilot',
    sprintCapacityHours: 40,
    autopilotStart: '08:00',
    autopilotEnd: '18:00',
    autopilotDays: [1, 2, 3, 4, 5] as number[],
    databaseUrl: '',
    clearDatabase: false,
    githubMode: 'aus' as GithubMode,
    githubRequireApproval: false,
  };
  /** Wochentage der Arbeitszeiten (ISO: 1 = Montag). */
  protected readonly weekdays = [
    { day: 1, label: 'Mo' },
    { day: 2, label: 'Di' },
    { day: 3, label: 'Mi' },
    { day: 4, label: 'Do' },
    { day: 5, label: 'Fr' },
    { day: 6, label: 'Sa' },
    { day: 7, label: 'So' },
  ];

  protected toggleDay(day: number): void {
    const days = this.settings.autopilotDays;
    this.settings.autopilotDays = days.includes(day)
      ? days.filter((value) => value !== day)
      : [...days, day].sort((a, b) => a - b);
  }
  protected maxAgents = 2;
  protected deleteConfirm = '';
  protected deleteFolder = false;

  /** Projekt löschen; den Ordner löscht auf Wunsch der Worker auf dem Rechner. */
  protected async deleteProject(): Promise<void> {
    const project = this.store.currentProject();
    if (!project) return;
    const withFolder = this.deleteFolder;
    await this.store.perform(
      async () => {
        await this.api.delete(`/api/projects/${encodeURIComponent(project.slug)}`, {
          confirm: this.deleteConfirm,
          deleteFolder: withFolder,
        });
        this.deleteConfirm = '';
        this.deleteFolder = false;
        await this.store.loadProjects();
        this.store.navigate('dashboard');
      },
      `Projekt „${project.name}“ gelöscht${withFolder ? ' – der Ordner wird auf dem Rechner entfernt' : ''}.`,
      false,
    );
  }

  constructor() {
    effect(() => {
      this.store.foregroundLoads();
      untracked(() => this.fillSettings());
    });
    void this.loadMaxAgents();
  }

  protected async saveSettings(): Promise<void> {
    const slug = this.store.activeProject();
    await this.store.perform(
      async () => {
        const result = await this.api.patch<{ project: Project }>(`/api/projects/${encodeURIComponent(slug)}`, {
          repository: this.settings.repository.trim(),
          gitRemote: this.settings.gitRemote.trim(),
          testCommands: this.settings.testCommands,
          deployCommands: this.settings.deployCommands,
          description: this.settings.description,
          guidelines: this.settings.guidelines,
          definitionOfReady: this.settings.definitionOfReady,
          definitionOfDone: this.settings.definitionOfDone,
          autoBugfix: this.settings.autoBugfix,
          agentWorkspace: this.settings.agentWorkspace,
          reviewMode: this.settings.reviewMode,
          reviewCommand: this.settings.reviewCommand.trim(),
          restartAfterSprint: this.settings.restartAfterSprint,
          sprintMode: this.settings.sprintMode,
          sprintCapacityHours: this.settings.sprintCapacityHours,
          autopilotStart: this.settings.autopilotStart,
          autopilotEnd: this.settings.autopilotEnd,
          autopilotDays: this.settings.autopilotDays,
          githubMode: this.settings.githubMode,
          githubRequireApproval: this.settings.githubRequireApproval,
          ...(this.settings.clearDatabase
            ? { databaseUrl: '' }
            : this.settings.databaseUrl.trim()
              ? { databaseUrl: this.settings.databaseUrl.trim() }
              : {}),
        });
        this.store.projects.update((projects) =>
          projects.map((project) => (project.slug === slug ? { ...project, ...result.project } : project)),
        );
        await this.store.loadProject(slug);
      },
      'Projekteinstellungen gespeichert.',
      false,
    );
  }

  /** Die Brücke braucht ein GitHub-Repository (wie im Backend über githubRepo geprüft). */
  protected githubRemote(): boolean {
    return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)[^/\s]+\/[^/\s]+$/.test(
      this.settings.gitRemote.trim(),
    );
  }

  /** „Anmeldung erneut prüfen“: der Worker fragt `gh auth status` beim nächsten Takt ab. */
  protected async checkGithub(): Promise<void> {
    const slug = this.store.activeProject();
    await this.store.perform(
      async () => {
        await this.api.post(`/api/projects/${encodeURIComponent(slug)}/github/check`, {});
        await this.store.loadProject(slug);
      },
      'Anmeldung wird beim nächsten Worker-Takt (spätestens in einer Minute) geprüft.',
      false,
    );
  }

  protected async saveMaxAgents(): Promise<void> {
    await this.store.perform(
      async () => {
        await this.api.put('/api/settings', { maxConcurrentAgents: Number(this.maxAgents) });
        await this.loadMaxAgents();
      },
      'Anzahl gleichzeitiger Agents gespeichert.',
      false,
    );
  }

  private fillSettings(): void {
    const project = this.store.currentProject();
    this.settings = {
      repository: project?.repository ?? '',
      gitRemote: project?.gitRemote ?? '',
      description: project?.description ?? '',
      guidelines: project?.guidelines ?? '',
      definitionOfReady: (project?.definitionOfReady ?? []).join('\n'),
      definitionOfDone: (project?.definitionOfDone ?? []).join('\n'),
      autoBugfix: project?.autoBugfix ?? true,
      agentWorkspace: project?.agentWorkspace ?? false,
      reviewMode: project?.reviewMode ?? 'off',
      reviewCommand: (project?.reviewCommand ?? []).join(' '),
      restartAfterSprint: project?.restartAfterSprint ?? false,
      sprintMode: project?.sprintMode ?? 'manual',
      sprintCapacityHours: project?.sprintCapacityHours ?? 40,
      autopilotStart: project?.autopilotStart ?? '08:00',
      autopilotEnd: project?.autopilotEnd ?? '18:00',
      autopilotDays: [...(project?.autopilotDays ?? [1, 2, 3, 4, 5])],
      databaseUrl: '',
      clearDatabase: false,
      githubMode: project?.githubMode ?? 'aus',
      githubRequireApproval: project?.githubRequireApproval ?? false,
      deployCommands: (project?.deployCommands ?? []).map((command) => command.join(' ')).join('\n'),
      testCommands: (project?.testCommands ?? []).map((command) => command.join(' ')).join('\n'),
    };
  }

  private async loadMaxAgents(): Promise<void> {
    try {
      this.maxAgents = (await this.api.get<AgentStatus>('/api/agent-status')).maxConcurrentAgents;
    } catch {
      // the topbar already reports an unreachable worker
    }
  }
}
