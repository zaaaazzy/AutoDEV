import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NAVIGATION, type Section } from './core/navigation.js';
import { ProjectStore } from './core/project-store.js';
import { AgentListComponent } from './features/agents/agent-list.component.js';
import { AgentsComponent } from './features/agents/agents.component.js';
import { BugsComponent } from './features/bugs/bugs.component.js';
import { DashboardComponent } from './features/dashboard/dashboard.component.js';
import { DevelopmentComponent } from './features/development/development.component.js';
import { DocsComponent } from './features/docs/docs.component.js';
import { HelpDialogComponent } from './features/help/help-dialog.component.js';
import { IdeationComponent } from './features/ideation/ideation.component.js';
import { ProjectFormComponent } from './features/projects/project-form.component.js';
import { RunsComponent } from './features/runs/runs.component.js';
import { SettingsComponent } from './features/settings/settings.component.js';
import { SprintsComponent } from './features/sprints/sprints.component.js';
import { NavIconComponent } from './shared/nav-icon.component.js';

const CREATE_LABELS: Partial<Record<Section, string>> = {
  development: 'Neuer Auftrag',
  ideation: 'Neue Idee',
  sprints: 'Neuer Sprint',
  bugs: 'Neuer Bug',
  docs: 'Neues Handbuch',
};

/** Rahmen der Anwendung: Navigation, Projektwahl, Meldungen und der aktive Bereich. */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    FormsModule, NavIconComponent, AgentListComponent, ProjectFormComponent, HelpDialogComponent,
    DashboardComponent, DevelopmentComponent, SprintsComponent, IdeationComponent, BugsComponent,
    DocsComponent, AgentsComponent, RunsComponent, SettingsComponent,
  ],
  templateUrl: './app.component.html',
})
export class AppComponent {
  protected readonly store = inject(ProjectStore);
  protected readonly navigation = NAVIGATION;
  protected readonly section = this.store.section;
  protected readonly projects = this.store.projects;
  protected readonly activeProject = this.store.activeProject;
  protected readonly worker = this.store.worker;
  protected readonly loading = this.store.loading;
  protected readonly notice = this.store.notice;
  protected readonly busy = this.store.busy;
  protected readonly showCreate = this.store.showCreate;
  protected readonly menuClosed = signal(false);
  protected readonly showProjectForm = signal(false);
  protected readonly showHelp = signal(false);

  protected readonly activeSectionLabel = computed(() => this.navigation.find((item) => item.id === this.section())?.label);
  protected readonly resourceErrors = computed(() =>
    Object.entries(this.store.errors()).map(([resource, message]) => `${resource}: ${message}`));
  protected readonly createLabel = computed(() => {
    if (this.section() === 'agents') return this.store.selectedAgent() ? '' : 'Neuer Agent';
    return CREATE_LABELS[this.section()] ?? '';
  });
  protected readonly workerText = computed(() => {
    if (this.store.workerFailure()) return 'Worker-Status nicht abrufbar';
    const worker = this.worker();
    if (!worker.online) return worker.worker ? 'Worker offline' : 'Worker nicht gestartet';
    if (worker.running.length) return `Worker arbeitet: ${worker.running[0]!.title}`;
    return 'Worker bereit';
  });

  protected navCount(section: Section): number {
    const data = this.store.data();
    switch (section) {
      case 'development': return this.store.openDevelopmentCount();
      case 'sprints': return data.sprints.length;
      case 'ideation': return data.ideas.filter((idea) => idea.status !== 'rejected').length;
      case 'bugs': return this.store.openBugCount();
      case 'docs': return data.docs.length;
      case 'agents': return data.agents.length;
      case 'runs': return data.runs.length;
      default: return 0;
    }
  }
}
