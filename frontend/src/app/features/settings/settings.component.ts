import { Component, effect, inject, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import type { AgentStatus, Project } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { NotificationSettingsComponent } from './notification-settings.component.js';
import { SecuritySettingsComponent } from './security-settings.component.js';
import { UsersSettingsComponent } from './users-settings.component.js';
import { AuthService } from '../../core/auth.service.js';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [FormsModule, NotificationSettingsComponent, SecuritySettingsComponent, UsersSettingsComponent],
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
    sprintMode: 'manual' as 'manual' | 'suggest' | 'autopilot',
    sprintCapacityHours: 40,
    databaseUrl: '',
    clearDatabase: false,
  };
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
          sprintMode: this.settings.sprintMode,
          sprintCapacityHours: this.settings.sprintCapacityHours,
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
      sprintMode: project?.sprintMode ?? 'manual',
      sprintCapacityHours: project?.sprintCapacityHours ?? 40,
      databaseUrl: '',
      clearDatabase: false,
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
