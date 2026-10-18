import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from './core/api.service.js';
import { AuthService } from './core/auth.service.js';
import { NAVIGATION, type Section } from './core/navigation.js';
import { LoginComponent } from './features/auth/login.component.js';
import { ProjectStore } from './core/project-store.js';
import { AgentListComponent } from './features/agents/agent-list.component.js';
import { AgentsComponent } from './features/agents/agents.component.js';
import { BugsComponent } from './features/bugs/bugs.component.js';
import { DashboardComponent } from './features/dashboard/dashboard.component.js';
import { DevelopmentComponent } from './features/development/development.component.js';
import { DocsComponent } from './features/docs/docs.component.js';
import { HelpDialogComponent } from './features/help/help-dialog.component.js';
import { IdeationComponent } from './features/ideation/ideation.component.js';
import { ProjectSwitcherComponent } from './features/projects/project-switcher.component.js';
import { ProjectWizardComponent } from './features/projects/project-wizard.component.js';
import { RunsComponent } from './features/runs/runs.component.js';
import { SettingsComponent } from './features/settings/settings.component.js';
import { StatsComponent } from './features/stats/stats.component.js';
import { SprintsComponent } from './features/sprints/sprints.component.js';
import { NavIconComponent } from './shared/nav-icon.component.js';
import { firstStepsTour } from './features/tour/first-steps.tour.js';
import { TourOverlayComponent } from './features/tour/tour-overlay.component.js';
import { TourService } from './features/tour/tour.service.js';
import { WelcomeDialogComponent } from './features/tour/welcome-dialog.component.js';

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
    FormsModule,
    LoginComponent,
    TourOverlayComponent,
    WelcomeDialogComponent,
    NavIconComponent,
    AgentListComponent,
    ProjectWizardComponent,
    ProjectSwitcherComponent,
    HelpDialogComponent,
    DashboardComponent,
    DevelopmentComponent,
    SprintsComponent,
    IdeationComponent,
    BugsComponent,
    DocsComponent,
    AgentsComponent,
    RunsComponent,
    SettingsComponent,
    StatsComponent,
  ],
  templateUrl: './app.component.html',
})
export class AppComponent {
  protected readonly store = inject(ProjectStore);
  protected readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  protected readonly tour = inject(TourService);
  /** Nach dem Anlegen eines Projekts die Tour anbieten. */
  protected readonly afterProject = signal(false);
  /** Begrüßung in dieser Sitzung weggeklickt (sonst erscheint sie ohne Projekt jedes Mal). */
  protected readonly welcomeDismissed = signal(false);
  protected readonly showWelcome = computed(
    () =>
      !this.loading() &&
      !this.showProjectForm() &&
      !this.tour.active() &&
      (this.afterProject() || (!this.welcomeDismissed() && (this.tour.welcome() || !this.projects().length))),
  );

  protected startTour(): void {
    this.afterProject.set(false);
    this.showHelp.set(false);
    this.mobileMenu.set(false);
    this.tour.start(firstStepsTour(this.api));
  }

  protected dismissWelcome(): void {
    this.tour.dismissWelcome();
    this.afterProject.set(false);
    this.welcomeDismissed.set(true);
  }
  /** Favicon der betreuten Anwendung neben der Projektauswahl, falls vorhanden. */
  /** Favicon-Adresse, die nicht geladen werden konnte – dann erscheint wieder das Dev-Log-Logo. */
  protected readonly failedFavicon = signal<string | null>(null);
  protected readonly visibleFavicon = computed(() => {
    const icon = this.favicon();
    return icon && icon !== this.failedFavicon() ? icon : null;
  });
  protected readonly favicon = computed(() => {
    const project = this.store.currentProject();
    return project?.faviconVersion
      ? this.api.url(`/api/projects/${encodeURIComponent(project.slug)}/favicon?v=${project.faviconVersion}`)
      : null;
  });
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
  /** Ausgeklappte Navigation auf schmalen Bildschirmen. */
  protected readonly mobileMenu = signal(false);
  /** Agent-Liste aus der Handy-Kopfzeile. */
  protected readonly mobileAgents = signal(false);
  protected readonly showProjectForm = signal(false);
  protected readonly showHelp = signal(false);

  protected readonly activeSectionLabel = computed(
    () => this.navigation.find((item) => item.id === this.section())?.label,
  );
  protected readonly resourceErrors = computed(() =>
    Object.entries(this.store.errors()).map(([resource, message]) => `${resource}: ${message}`),
  );
  protected readonly createLabel = computed(() => {
    const section = this.section();
    if (section === 'agents') return this.store.selectedAgent() || !this.auth.can('agents') ? '' : 'Neuer Agent';
    const role = section === 'docs' ? 'docs' : 'plan';
    return this.auth.user() && this.auth.can(role) ? (CREATE_LABELS[section] ?? '') : '';
  });
  /** Laufender Sprint mit erledigten/geplanten Aufgaben für die Kopfzeile. */
  protected readonly activeSprint = computed(() => {
    const data = this.store.data();
    const sprint = data.sprints.find((candidate) => candidate.status === 'active');
    if (!sprint) return null;
    const items = data.development.filter((item) => item.sprintId === sprint.id);
    const done = items.filter((item) => item.status === 'done').length;
    const running = items.filter((item) => item.status === 'in_progress').length;
    const agentBusy = this.worker().agents.some((agent) => agent.active && agent.sprintName === sprint.name);
    // Alles erledigt und kein Agent mehr am Sprint: Haken statt blinkendem Punkt.
    const finished = items.length > 0 && done === items.length && running === 0 && !agentBusy;
    return { name: sprint.name, done, total: items.length, running, finished };
  });
  /** Zustand des laufenden Sprints für die Menü-Bubble: grün läuft, orange Fehler, rot gestoppt. */
  protected readonly sprintHealth = computed(() => {
    const data = this.store.data();
    const sprint = data.sprints.find((candidate) => candidate.status === 'active');
    if (!sprint) return null;
    const items = data.development.filter((item) => item.sprintId === sprint.id);
    const open = items.filter((item) => item.status !== 'done').length;
    const worker = this.worker();
    if (this.store.workerFailure() || !worker.online)
      return { open, tone: 'stopped', text: 'Sprint gestoppt: Worker offline' };
    const failed = items.some(
      (item) =>
        item.status === 'blocked' ||
        (item.status !== 'done' &&
          data.agentRuns
            .filter((run) => run.developmentId === item.id)
            .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0]?.status === 'failed'),
    );
    return failed
      ? { open, tone: 'warn', text: 'Sprint läuft mit Fehlern' }
      : { open, tone: 'ok', text: 'Sprint läuft' };
  });

  /** Zustand des Sprint-Chips im Handy-Header: fertig, gestoppt, Risiko, läuft oder wartet. */
  protected readonly sprintState = computed<'done' | 'stopped' | 'warn' | 'running' | 'idle' | null>(() => {
    const sprint = this.activeSprint();
    if (!sprint) return null;
    if (sprint.finished) return 'done';
    const tone = this.sprintHealth()?.tone;
    if (tone === 'stopped') return 'stopped';
    if (tone === 'warn') return 'warn';
    const busy = this.worker().agents.some((agent) => agent.active && agent.sprintName === sprint.name);
    return sprint.running || busy ? 'running' : 'idle';
  });

  protected navTone(section: Section): string {
    if (section === 'dashboard') return 'warn';
    return section === 'sprints' ? (this.sprintHealth()?.tone ?? '') : '';
  }

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
      case 'development':
        return this.store.openDevelopmentCount();
      case 'sprints':
        return this.sprintHealth()?.open ?? 0;
      case 'ideation':
        return data.ideas.filter((idea) => {
          const order = data.development.find((item) => item.ideationId === idea.id);
          return idea.status === 'accepted' && order?.status !== 'done';
        }).length;
      case 'bugs':
        return this.store.openBugCount();
      case 'docs':
        return data.docs.length;
      case 'agents':
        return data.agents.length;
      case 'runs':
        return data.runs.length;
      case 'dashboard':
        return this.store.openQuestion() ? 1 : 0;
      default:
        return 0;
    }
  }
}
