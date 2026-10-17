import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { ApiService } from './api.service.js';
import { errorMessage } from './errors.js';
import {
  emptyProjectData,
  type DevelopmentItem,
  type Project,
  type ProjectData,
  type Sprint,
  type WorkerStatus,
} from './models.js';
import { isSection, sectionFromHash, type Section } from './navigation.js';
import { fetchProjectData } from './project-loader.js';

const WORKER_REFRESH_MS = 10_000;
const LIVE_RUNS_REFRESH_MS = 3_000;
const ACTIVE_PROJECT_KEY = 'devlog.activeProject';

/** Zuletzt gewähltes Projekt, damit ein Reload dasselbe Projekt öffnet. Speicher kann fehlen oder gesperrt sein. */
function readStoredProject(): string {
  try {
    return globalThis.localStorage?.getItem(ACTIVE_PROJECT_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeProject(slug: string): void {
  try {
    if (slug) globalThis.localStorage?.setItem(ACTIVE_PROJECT_KEY, slug);
  } catch {
    // Ohne Speicher wird beim nächsten Laden einfach das erste Projekt gewählt.
  }
}

/** Gemeinsamer Zustand: Projekte, geladene Projektdaten, Navigation, Hintergrund-Aktualisierung. */
const NOTICE_MS = 5000;

@Injectable({ providedIn: 'root' })
export class ProjectStore {
  private readonly api = inject(ApiService);
  private requestVersion = 0;

  readonly projects = signal<Project[]>([]);
  readonly activeProject = signal(readStoredProject());
  readonly data = signal<ProjectData>(emptyProjectData());
  readonly errors = signal<Record<string, string>>({});
  readonly section = signal<Section>(sectionFromHash());
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly notice = signal('');
  readonly showCreate = signal(false);
  readonly openAgent = signal<string | null>(null);
  readonly worker = signal<WorkerStatus>({ online: false, worker: null, running: [], agents: [] });
  readonly workerFailure = signal(false);
  /** Zählt Ladevorgänge im Vordergrund; Formulare mit Projektwerten laden sich daran neu. */
  readonly foregroundLoads = signal(0);

  readonly ready = computed(() => !this.loading() && this.projects().length > 0);
  readonly currentProject = computed(
    () => this.projects().find((project) => project.slug === this.activeProject()) ?? null,
  );
  readonly selectedAgent = computed(() => this.data().agents.find((agent) => agent.id === this.openAgent()) ?? null);
  readonly activeAgentCount = computed(() => this.worker().agents.filter((agent) => agent.active).length);
  /** Offene Rückfrage des Dashboard-Assistenten, falls vorhanden. */
  readonly openQuestion = computed(() => this.worker().agents.find((agent) => agent.waiting)?.orderTitle ?? null);
  readonly openDevelopmentCount = computed(
    () => this.data().development.filter((item) => item.status !== 'done').length,
  );
  readonly openBugCount = computed(
    () => this.data().bugs.filter((bug) => bug.status === 'open' || bug.status === 'in_progress').length,
  );

  constructor() {
    const onHashChange = (): void => this.onHashChange();
    const onVisibilityChange = (): void => {
      if (!document.hidden) this.refreshActiveProject();
    };
    globalThis.addEventListener('hashchange', onHashChange);
    document.addEventListener('visibilitychange', onVisibilityChange);
    void this.loadProjects();
    const refreshTimer = globalThis.setInterval(() => void this.refreshWorker(), WORKER_REFRESH_MS);
    const liveTimer = globalThis.setInterval(() => void this.refreshLiveRuns(), LIVE_RUNS_REFRESH_MS);
    inject(DestroyRef).onDestroy(() => {
      globalThis.removeEventListener('hashchange', onHashChange);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      globalThis.clearInterval(refreshTimer);
      globalThis.clearInterval(liveTimer);
    });
  }

  sprintOf(item: DevelopmentItem | null): Sprint | null {
    return item?.sprintId ? (this.data().sprints.find((sprint) => sprint.id === item.sprintId) ?? null) : null;
  }

  navigate(section: string): void {
    if (!isSection(section)) return;
    this.section.set(section);
    this.showCreate.set(false);
    this.openAgent.set(null);
    globalThis.history.replaceState(null, '', `#${section}`);
    this.refreshActiveProject();
  }

  async loadProjects(selectedSlug = this.activeProject()): Promise<void> {
    this.loading.set(true);
    this.notice.set('');
    try {
      const projects = await this.api.projects();
      this.projects.set(projects);
      if (!projects.length) {
        this.activeProject.set('');
        this.data.set(emptyProjectData());
        return;
      }
      const slug = projects.some((project) => project.slug === selectedSlug) ? selectedSlug : projects[0]!.slug;
      await this.loadProject(slug);
    } catch (error) {
      this.notice.set(errorMessage(error, 'Projekte konnten nicht geladen werden.'));
    } finally {
      this.loading.set(false);
    }
  }

  /** `background` lädt nur die Daten nach und lässt offene Formulare, Meldungen und Eingaben unangetastet. */
  async loadProject(slug: string, background = false): Promise<void> {
    const version = ++this.requestVersion;
    this.activeProject.set(slug);
    storeProject(slug);
    if (!background) {
      this.openAgent.set(null);
      this.loading.set(true);
      this.notice.set('');
      this.foregroundLoads.update((count) => count + 1);
    }
    if (!slug) {
      this.data.set(emptyProjectData());
      this.loading.set(false);
      return;
    }
    const { data, errors } = await fetchProjectData(this.api, slug);
    if (version !== this.requestVersion) return;

    this.data.set(data);
    this.errors.set(errors);
    this.loading.set(false);
    if (!background && Object.keys(errors).length) {
      this.notice.set(`Einige Bereiche konnten nicht geladen werden: ${Object.keys(errors).join(', ')}.`);
    }
    void this.refreshWorker();
  }

  async perform(action: () => Promise<unknown>, success: string, refresh = true): Promise<void> {
    this.busy.set(true);
    this.notice.set('');
    try {
      await action();
      if (refresh && this.activeProject()) await this.loadProject(this.activeProject());
      this.notice.set(success);
      setTimeout(() => {
        if (this.notice() === success) this.notice.set('');
      }, NOTICE_MS);
    } catch (error) {
      this.notice.set(errorMessage(error, 'Aktion fehlgeschlagen.'));
    } finally {
      this.busy.set(false);
    }
  }

  async refreshWorker(): Promise<void> {
    const slug = this.activeProject();
    if (!slug) return;
    try {
      const status = await this.api.get<WorkerStatus>(`${this.api.projectPath(slug)}/worker`);
      if (slug === this.activeProject()) {
        this.worker.set(status);
        this.workerFailure.set(false);
      }
    } catch {
      if (slug === this.activeProject()) {
        this.workerFailure.set(true);
        this.worker.update((worker) => ({ ...worker, online: false }));
      }
    }
  }

  private onHashChange(): void {
    const section = sectionFromHash();
    if (section === this.section()) return;
    this.section.set(section);
    this.refreshActiveProject();
  }

  private refreshActiveProject(): void {
    const slug = this.activeProject();
    if (slug && !this.loading()) void this.loadProject(slug, true);
  }

  private async refreshLiveRuns(): Promise<void> {
    const slug = this.activeProject();
    if (!slug || !this.data().agentRuns.some((run) => run.steps.some((step) => step.status === 'running'))) return;
    try {
      const { runs } = await this.api.get<{ runs?: ProjectData['agentRuns'] }>(
        `${this.api.projectPath(slug)}/agent-runs`,
      );
      if (slug === this.activeProject()) this.data.update((data) => ({ ...data, agentRuns: runs ?? [] }));
    } catch {
      /* nächster Versuch in 3 s */
    }
  }
}
