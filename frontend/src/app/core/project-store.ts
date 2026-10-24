import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { ApiService } from './api.service.js';
import { errorMessage, FieldError } from './errors.js';
import {
  emptyProjectData,
  type DevelopmentItem,
  type Project,
  type ProjectData,
  type Sprint,
  type WorkerStatus,
} from './models.js';
import { isSection, projectFromHash, sectionFromHash, targetFromHash, type Section } from './navigation.js';
import { fetchProjectData, keepFailedSections, runningOrdersChanged, runStepFinished } from './project-loader.js';
import { isFinished } from '../shared/labels.js';
import { orderAttention } from '../shared/order-attention.js';
import { visibleInterval } from './visible-interval.js';

const WORKER_REFRESH_MS = 10_000;
const LIVE_RUNS_REFRESH_MS = 3_000;
const ACTIVE_PROJECT_KEY = 'devlog.activeProject';
/** Immer dasselbe Objekt, sonst sehen Tabellen bei jeder Prüfung neue Filter und rendern endlos neu. */
const NO_FILTERS: Record<string, string[]> = Object.freeze({}) as Record<string, string[]>;

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
  /** Projekt, zu dem `data` aktuell gehört. */
  private loadedSlug = '';
  /** Projekt, zu dem `worker` gehört (Entwürfe nur innerhalb desselben Projekts vergleichen). */
  private workerSlug = '';

  readonly projects = signal<Project[]>([]);
  readonly activeProject = signal(projectFromHash() ?? readStoredProject());
  readonly data = signal<ProjectData>(emptyProjectData());
  readonly errors = signal<Record<string, string>>({});
  readonly section = signal<Section>(sectionFromHash());
  /** Eintrag, der auf der Seite geöffnet werden soll (Auftrag, Dokument) – aus Link oder Adresse. */
  readonly focusId = signal<string | null>(targetFromHash());
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
    () => this.data().development.filter((item) => !isFinished(item.status)).length,
  );
  /** Aufträge mit Handlungsbedarf (Seite „Aktionen“, Menü-Bubble). */
  readonly attention = computed(() => orderAttention(this.data().development, this.data().acceptance));
  readonly attentionIds = computed(() => new Set(this.attention().map((entry) => entry.item.id)));
  readonly openBugCount = computed(
    () => this.data().bugs.filter((bug) => bug.status === 'open' || bug.status === 'in_progress').length,
  );

  constructor() {
    const onHashChange = (): void => this.onHashChange();
    const onVisibilityChange = (): void => {
      if (!document.hidden) this.refreshActiveProject();
    };
    // Angetippte Push-Nachricht: Der Service Worker schickt den Link, statt nur den Hash zu setzen (gleicher Hash
    // löst sonst kein „hashchange“ aus).
    const onWorkerMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: string; url?: unknown } | null;
      if (data?.type === 'open' && typeof data.url === 'string') this.openLink(data.url);
    };
    globalThis.addEventListener('hashchange', onHashChange);
    document.addEventListener('visibilitychange', onVisibilityChange);
    globalThis.navigator?.serviceWorker?.addEventListener('message', onWorkerMessage);
    void this.loadProjects();
    // Verborgene Tabs pollen nicht; beim Zurückkehren wird sofort nachgeladen.
    const stopWorker = visibleInterval(() => void this.refreshWorker(), WORKER_REFRESH_MS);
    const stopLiveRuns = visibleInterval(() => void this.refreshLiveRuns(), LIVE_RUNS_REFRESH_MS);
    inject(DestroyRef).onDestroy(() => {
      globalThis.removeEventListener('hashchange', onHashChange);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      globalThis.navigator?.serviceWorker?.removeEventListener('message', onWorkerMessage);
      stopWorker();
      stopLiveRuns();
    });
  }

  /** Ist `slug` noch das aktive Projekt? Nach jedem `await` prüfen, sonst landen Antworten im falschen Projekt. */
  isActive(slug: string): boolean {
    return !!slug && slug === this.activeProject();
  }

  sprintOf(item: DevelopmentItem | null): Sprint | null {
    return item?.sprintId ? (this.data().sprints.find((sprint) => sprint.id === item.sprintId) ?? null) : null;
  }

  /** Filter, mit denen eine Seite über einen Link (z. B. aus dem Dashboard) geöffnet wurde. */
  readonly linkFilters = signal<{ section: Section; filters: Record<string, string[]> } | null>(null);

  /** Spaltenfilter für die Tabelle einer Seite, wenn sie über einen Link mit Filter geöffnet wurde. */
  filtersFor(section: Section): Record<string, string[]> {
    const link = this.linkFilters();
    return link?.section === section ? link.filters : NO_FILTERS;
  }

  /** Wechselt die Seite; optional mit Tabellenfiltern und einem Abschnitt, zu dem gescrollt wird. */
  navigate(section: string, link: { filters?: Record<string, string[]>; anchor?: string; focus?: string } = {}): void {
    if (!isSection(section)) return;
    this.focusId.set(link.focus ?? null);
    this.linkFilters.set(link.filters ? { section, filters: link.filters } : null);
    if (link.anchor) {
      const anchor = link.anchor;
      globalThis.setTimeout(() => globalThis.document?.getElementById(anchor)?.scrollIntoView({ block: 'start' }), 150);
    } else {
      globalThis.scrollTo?.({ top: 0 });
    }
    this.section.set(section);
    this.showCreate.set(false);
    this.openAgent.set(null);
    globalThis.history.replaceState(null, '', link.focus ? `#${section}/${link.focus}` : `#${section}`);
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
        this.loadedSlug = '';
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
      this.loadedSlug = '';
      this.data.set(emptyProjectData());
      this.loading.set(false);
      return;
    }
    const loaded = await fetchProjectData(this.api, slug);
    if (version !== this.requestVersion) return;
    const { errors } = loaded;

    // Im Hintergrund (gleiches Projekt) behalten fehlgeschlagene Bereiche ihre bisherigen Daten.
    const sameProject = background && this.loadedSlug === slug;
    this.data.set(sameProject ? keepFailedSections(this.data(), loaded) : loaded.data);
    this.loadedSlug = slug;
    this.errors.set(errors);
    this.loading.set(false);
    if (!background && Object.keys(errors).length) {
      this.notice.set(`Einige Bereiche konnten nicht geladen werden: ${Object.keys(errors).join(', ')}.`);
    }
    void this.refreshWorker();
  }

  /**
   * Antwort des Servers zu einem Auftrag sofort übernehmen (Freigabe, erneuter Versuch …), bevor das ganze Projekt
   * nachgeladen ist: Die Rückmeldung unter „Aktionen“ verschwindet damit gleich beim Klick.
   */
  applyItem(response: unknown): void {
    const item = (response as { item?: Partial<DevelopmentItem> & { id?: string } } | null)?.item;
    if (!item?.id) return;
    this.data.update((data) => ({
      ...data,
      development: data.development.map((entry) => (entry.id === item.id ? { ...entry, ...item } : entry)),
    }));
  }

  async perform(action: () => Promise<unknown>, success: string, refresh = true): Promise<void> {
    this.busy.set(true);
    this.notice.set('');
    try {
      this.applyItem(await action());
      // Im Hintergrund nachladen: Die Seite bleibt stehen, aufgeklappte Zeilen und Dialoge bleiben offen.
      if (refresh && this.activeProject()) await this.loadProject(this.activeProject(), true);
      this.notice.set(success);
      setTimeout(() => {
        if (this.notice() === success) this.notice.set('');
      }, NOTICE_MS);
    } catch (error) {
      // Steht die Meldung schon am Formularfeld, nicht zusätzlich oben anzeigen.
      if (!(error instanceof FieldError && error.shown)) this.notice.set(errorMessage(error, 'Aktion fehlgeschlagen.'));
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
        // Ist ein Auftrag fertig geschrieben, sofort nachladen, damit er in der Liste erscheint.
        const current = new Set((status.drafts ?? []).map((draft) => draft.id));
        const previous = this.workerSlug === slug ? (this.worker().drafts ?? []) : [];
        const finished = previous.some((draft) => !current.has(draft.id));
        // Auftrag fertig oder neu gestartet: Status, Sprint und Läufe nachladen. Der Reload ruft refreshWorker erneut
        // auf, vergleicht dann aber mit diesem Stand und löst keinen weiteren Reload aus.
        const ordersChanged =
          this.workerSlug === slug && runningOrdersChanged(this.worker().running ?? [], status.running ?? []);
        this.worker.set(status);
        this.workerSlug = slug;
        if (finished || ordersChanged) this.refreshActiveProject();
        this.workerFailure.set(false);
      }
    } catch {
      if (slug === this.activeProject()) {
        this.workerFailure.set(true);
        this.worker.update((worker) => ({ ...worker, online: false }));
      }
    }
  }

  /** Link aus einer Push-Nachricht öffnen (Projekt im Link wird über `onHashChange` gewählt). */
  private openLink(url: string): void {
    const hash = new URL(url, globalThis.location.href).hash;
    if (!hash) return;
    if (hash === globalThis.location.hash) this.onHashChange();
    else globalThis.location.hash = hash;
  }

  private onHashChange(): void {
    const section = sectionFromHash();
    this.focusId.set(targetFromHash());
    // Zurück aus der Agent-Detailansicht (#agents/<id> → #agents): Detail schließen.
    if (this.openAgent() && targetFromHash() !== this.openAgent()) this.openAgent.set(null);
    // Link aus einer Push-Nachricht eines anderen Projekts: dorthin wechseln.
    const project = projectFromHash();
    if (project && project !== this.activeProject() && this.projects().some((entry) => entry.slug === project)) {
      this.section.set(section);
      void this.loadProject(project);
      return;
    }
    if (section === this.section()) return;
    // Wie navigate(): neue Seite oben beginnen und ein offenes Anlegeformular der alten Seite nicht mitnehmen.
    globalThis.scrollTo?.({ top: 0 });
    this.section.set(section);
    this.showCreate.set(false);
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
      if (slug !== this.activeProject() || slug !== this.loadedSlug) return;
      const finished = runStepFinished(this.data().agentRuns, runs ?? []);
      this.data.update((data) => ({ ...data, agentRuns: runs ?? [] }));
      // Letzter Schritt fertig: Danach pollt hier nichts mehr, also jetzt Auftrag, Sprint und Berichte nachladen.
      if (finished) this.refreshActiveProject();
    } catch {
      /* nächster Versuch in 3 s */
    }
  }
}
