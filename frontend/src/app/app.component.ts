import { CommonModule } from '@angular/common';
import { Component, HostListener, OnDestroy, OnInit, computed, effect, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from './api.service.js';
import { MarkdownPipe } from './markdown.pipe.js';
import {
  type Agent,
  type AgentPhase,
  type Attachment,
  type Bug,
  type ChatMessage,
  type BugStatus,
  type DevelopmentItem,
  type IdeaComment,
  type DevelopmentStatus,
  type DocumentEntry,
  type Estimate,
  type Idea,
  type Priority,
  type Project,
  type ProjectData,
  type ProjectStats,
  type Sprint,
  type SprintReport,
  type TestRun,
  type WorkerStatus,
  type AgentStatus,
  type AgentActivity,
  type UpcomingTask,
  emptyProjectData,
} from './models.js';

type IdeaSortKey = 'title' | 'description' | 'status' | 'priority' | 'effortHours' | 'createdAt';
type Section = 'dashboard' | 'development' | 'sprints' | 'ideation' | 'bugs' | 'docs' | 'agents' | 'runs' | 'settings';
type FormValues = Record<string, unknown>;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const SECTION_LABELS: Record<Section, string> = {
  dashboard: 'Dashboard',
  development: 'Auftrag',
  sprints: 'Sprints',
  ideation: 'Ideation',
  bugs: 'Bugs',
  docs: 'Dokumentation',
  agents: 'Agents',
  runs: 'Testläufe',
  settings: 'Einstellungen',
};

type DevKey = 'title' | 'description' | 'status' | 'priority' | 'sprint' | 'effortHours';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, MarkdownPipe],
  templateUrl: './app.component.html',
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly api: ApiService;
  private requestVersion = 0;
  private refreshTimer = 0;

  constructor(api: ApiService) {
    this.api = api;
  }

  resourceErrors(): string[] {
    return Object.entries(this.errors()).map(([resource, message]) => `${resource}: ${message}`);
  }

  readonly navigation: { id: Section; label: string }[] = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'docs', label: 'Dokumentation' },
    { id: 'ideation', label: 'Ideation' },
    { id: 'development', label: 'Auftrag' },
    { id: 'sprints', label: 'Sprints' },
    { id: 'bugs', label: 'Bugs' },
    { id: 'runs', label: 'Testläufe' },
    { id: 'agents', label: 'Agents' },
    { id: 'settings', label: 'Einstellungen' },
  ];
  readonly developmentStatuses: DevelopmentStatus[] = ['backlog', 'planned', 'in_progress', 'blocked', 'done'];
  readonly ideaStatuses = ['idea', 'considering', 'requested', 'drafting', 'accepted', 'rejected'];
  readonly ideaSelectableStatuses = ['idea', 'considering'];
  readonly bugStatuses: BugStatus[] = ['open', 'in_progress', 'fixed', 'wontfix'];
  readonly severityLevels = ['critical', 'high', 'medium', 'low'];
  readonly agentRoles = [
    { value: 'author', label: 'Auftragsautor' },
    { value: 'developer', label: 'Entwickler' },
    { value: 'tester', label: 'Tester' },
    { value: 'reviewer', label: 'Reviewer' },
    { value: 'documenter', label: 'Dokumentierer' },
    { value: 'bug_reviewer', label: 'Bug-Wächter' },
    { value: 'manual_writer', label: 'Handbuch-Autor' },
    { value: 'custom', label: 'Eigene Rolle' },
  ];
  readonly phases: { id: AgentPhase; label: string; hint: string }[] = [
    { id: 'pre_task', label: 'Vorbereitung', hint: 'Kontext prüfen und Auftrag vorbereiten' },
    { id: 'while_task', label: 'Umsetzung', hint: 'Auftrag bearbeiten' },
    { id: 'after_task', label: 'Abschluss', hint: 'Tests, Review und Dokumentation' },
  ];
  readonly documentGroups: { kind: DocumentEntry['kind']; label: string }[] = [
    { kind: 'manual', label: 'Handbücher' },
    { kind: 'sprint', label: 'Sprintberichte' },
    { kind: 'order', label: 'Auftrags-Dokumentation' },
    { kind: 'repo', label: 'Repository' },
  ];

  readonly projects = signal<Project[]>([]);
  readonly activeProject = signal('');
  readonly chat = signal<ChatMessage[]>([]);
  readonly chatWaiting = computed(() => this.chat().some((message) => message.role === 'user' && ['pending', 'processing'].includes(message.status)));
  readonly chatProgressShown = computed(() => this.chat().some((message) => message.role === 'assistant' && message.status === 'processing'));
  chatInput = '';
  private chatStream: EventSource | null = null;
  private readonly chatEffect = effect((onCleanup) => {
    const slug = this.activeProject();
    if (this.section() !== 'dashboard' || !slug) return;
    this.chatStream = new EventSource(this.api.url(`${this.api.projectPath(slug)}/chat/stream`));
    this.chatStream.onmessage = (event: MessageEvent<string>) => {
      this.chat.set(JSON.parse(event.data) as ChatMessage[]);
      globalThis.setTimeout(() => {
        const log = document.querySelector('.chat-log');
        if (log) log.scrollTop = log.scrollHeight;
      });
    };
    onCleanup(() => { this.chatStream?.close(); this.chat.set([]); });
  });

  readonly data = signal<ProjectData>(emptyProjectData());
  readonly errors = signal<Record<string, string>>({});
  readonly section = signal<Section>(this.sectionFromHash());
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly showHelp = signal(false);
  readonly openIdea = signal<string | null>(null);
  readonly ideaEditing = signal(false);
  readonly showCreate = signal(false);
  readonly ideaTextFilter = signal<Partial<Record<'title' | 'description', string>>>({});
  private readonly defaultIdeaFilter = { status: ['Idee', 'In Abklärung', 'Wird ausformuliert'] };
  readonly ideaValueFilter = signal<Partial<Record<'status' | 'priority' | 'effortHours' | 'createdAt', string[]>>>({ ...this.defaultIdeaFilter });
  readonly menuClosed = signal(false);
  readonly showClosedIdeas = signal(false);
  readonly openClosedIdea = signal<string | null>(null);
  readonly closedIdeas = computed(() => this.data().ideas.filter((idea) => this.isClosedIdea(idea)));
  readonly ideaColumns: { key: IdeaSortKey; label: string }[] = [
    { key: 'title', label: 'Titel' }, { key: 'description', label: 'Kurzfassung' }, { key: 'status', label: 'Status' },
    { key: 'priority', label: 'Priorität' }, { key: 'effortHours', label: 'Aufwand' }, { key: 'createdAt', label: 'Erstellt' },
  ];
  readonly ideaSort = signal<{ key: IdeaSortKey; dir: 'asc' | 'desc' }>({ key: 'createdAt', dir: 'desc' });
  readonly filteredIdeas = computed(() => {
    const text = this.ideaTextFilter();
    const values = this.ideaValueFilter();
    return this.data().ideas.filter((idea) => !this.isClosedIdea(idea)).filter((idea) =>
      (['title', 'description'] as const).every((key) => !text[key] || (idea[key] ?? '').toLowerCase().includes(text[key]!.toLowerCase()))
      && (Object.keys(values) as (keyof typeof values)[]).every((key) => !values[key]?.length || values[key]!.includes(this.ideaCellValue(idea, key))));
  });
  readonly sortedIdeas = computed(() => {
    const { key, dir } = this.ideaSort();
    const rank = (idea: Idea): string | number | null => {
      switch (key) {
        case 'status': return this.ideaStatuses.indexOf(idea.status);
        case 'priority': return ['low', 'medium', 'high'].indexOf(idea.priority);
        case 'effortHours': return idea.effortHours ?? null;
        default: return (idea[key] ?? '').toString().toLowerCase();
      }
    };
    const factor = dir === 'asc' ? 1 : -1;
    return this.filteredIdeas().sort((a, b) => {
      const x = rank(a), y = rank(b);
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * factor;
    });
  });
  readonly selectedIdea = computed(() => this.data().ideas.find((idea) => idea.id === this.openIdea()) ?? null);
  readonly flow = [
    { icon: '💡', title: 'Idee', text: 'Ideen und Fotos im Ideationboard erfassen.' },
    { icon: '📋', title: 'Auftrag', text: 'Aus der Idee entsteht ein Entwicklungsauftrag.' },
    { icon: '🏁', title: 'Sprint', text: 'Aufträge einem Sprint zuweisen und diesen starten.' },
    { icon: '🤖', title: 'Agents', text: 'Agents setzen die Aufträge um und testen.' },
    { icon: '🐞', title: 'Bugs', text: 'Fehler werden erfasst und wieder eingeplant.' },
    { icon: '📄', title: 'Doku & Git', text: 'Sprint abschließen: Bericht, Doku und Git-Sicherung.' },
  ];
  readonly workflow = [
    { object: 'Idee', icon: '💡', steps: [
      { status: 'Idee', agent: null, rule: 'Nutzer erfasst die Idee. Der Worker lässt den Auftragsautor beim nächsten Zyklus Aufwand und Kosten schätzen.' },
      { status: 'In Abklärung', agent: null, rule: 'Nutzer und Kommentare klären offene Punkte. Status wird manuell gesetzt, auch nach einem Agent-Fehler.' },
      { status: 'Wird ausformuliert', agent: 'Auftragsautor', rule: 'Berücksichtigt die Kommentare und erstellt den Auftrag. Bei Fehler zurück auf „In Abklärung“.' },
      { status: 'Auftrag erstellt', agent: null, rule: 'Endzustand. Der Auftrag liegt im Backlog.' },
    ] },
    { object: 'Auftrag', icon: '📋', steps: [
      { status: 'Backlog', agent: null, rule: 'Nutzer weist einen Sprint zu, danach automatisch „Geplant“. Alternativ wählt er einen einzelnen Agent und startet ihn mit ▶.' },
      { status: 'Geplant', agent: 'Bug-Wächter', rule: 'Der Worker startet ihn, wenn der Sprint aktiv ist; dann laufen grundsätzlich alle Agents der Reihe nach. Manuell gestartet läuft nur der gewählte Agent (einmalig).' },
      { status: 'In Arbeit', agent: 'Entwickler', rule: 'Setzt den Auftrag um. Läuft alles durch, wird er „Erledigt“.' },
      { status: 'Erledigt', agent: 'Tester · Dokumentierer', rule: 'Tests bestanden, Doku und Handbuch werden nachgeführt.' },
      { status: 'Blockiert', agent: null, rule: 'Ein Agent ist fehlgeschlagen. Nutzer prüft und plant neu.' },
    ] },
    { object: 'Sprint', icon: '🏁', steps: [
      { status: 'Geplant → Aktiv → Abgeschlossen', agent: null, rule: 'Nutzer startet und beendet Sprints manuell. Agents ändern den Sprint-Status nie.' },
    ] },
    { object: 'Bug', icon: '🐞', steps: [
      { status: 'Offen', agent: 'Bug-Wächter', rule: 'Prüft vor einem Auftrag offene Bugs und plant sie ein.' },
      { status: 'Behoben / Kein Fix', agent: null, rule: 'Nutzer setzt den Endstatus.' },
    ] },
  ];
  readonly manualAgent: Record<string, string> = {};
  readonly notice = signal('');
  readonly showProjectForm = signal(false);
  readonly selectedDoc = signal<DocumentEntry | null>(null);
  readonly bugFilter = signal<'all' | BugStatus>('all');
  readonly worker = signal<WorkerStatus>({ online: false, worker: null, running: [], agents: [] });
  readonly workerFailure = signal(false);
  readonly agentStatus = signal<AgentStatus>({ maxConcurrentAgents: 2, projects: [], running: [] });
  maxAgents = 2;
  readonly openAgent = signal<string | null>(null);
  readonly agentActivity = signal<AgentActivity[]>([]);
  readonly agentUpcoming = signal<UpcomingTask[]>([]);
  readonly agentActive = computed(() => this.agentActivity().filter((entry) => entry.stepStatus === 'running'));
  readonly agentDone = computed(() => this.agentActivity().filter((entry) => entry.stepStatus !== 'running'));
  readonly agentActivityLoading = signal(false);
  readonly selectedAgent = computed(() => this.data().agents.find((agent) => agent.id === this.openAgent()) ?? null);
  readonly currentProject = computed(() => this.projects().find((project) => project.slug === this.activeProject()) ?? null);
  readonly activeSprint = computed(() => this.data().sprints.find((sprint) => sprint.status === 'active') ?? null);

  projectForm = { name: '', slug: '', repository: '', gitRemote: '' };
  settings = { repository: '', testCommands: '', gitRemote: '', description: '', guidelines: '' };
  developmentForm: { title: string; priority: Priority } = { title: '', priority: 'medium' };
  pendingImages: File[] = [];
  ideaForm = { title: '', description: '', priority: 'medium' as Priority };
  sprintForm = { name: '', goal: '', startDate: '', endDate: '' };
  bugForm = { title: '', description: '', severity: 'medium', sprintId: '' };
  docForm = { title: '', content: '' };
  agentForm = { name: '', role: 'developer', phase: 'while_task' as AgentPhase, command: '', instructions: '' };

  ngOnInit(): void {
    void this.loadProjects();
    this.refreshTimer = globalThis.setInterval(() => void this.refreshWorker(), 10_000);
    void this.refreshAgentStatus(true);
  }

  ngOnDestroy(): void {
    this.chatStream?.close();
    globalThis.clearInterval(this.refreshTimer);
  }

  @HostListener('document:click', ['$event'])
  closeColumnFilters(event: Event): void {
    document.querySelectorAll('.col-filter[open]').forEach((filter) => {
      if (!filter.contains(event.target as Node)) filter.removeAttribute('open');
    });
  }

  @HostListener('window:hashchange')
  onHashChange(): void {
    this.section.set(this.sectionFromHash());
  }

  async sendChat(): Promise<void> {
    const content = this.chatInput.trim();
    if (!content || !this.activeProject()) return;
    this.chatInput = '';
    try {
      await this.api.post(`${this.api.projectPath(this.activeProject())}/chat`, { content });
    } catch (error) {
      this.chatInput = content;
      this.notice.set(error instanceof Error ? error.message : 'Nachricht konnte nicht gesendet werden.');
    }
  }

  async clearChat(): Promise<void> {
    await this.api.delete(`${this.api.projectPath(this.activeProject())}/chat`);
  }

  navigate(section: string): void {
    if (!this.isSection(section)) return;
    this.section.set(section);
    this.showCreate.set(false);
    this.openAgent.set(null);
    globalThis.history.replaceState(null, '', `#${section}`);
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
      this.notice.set(this.errorMessage(error, 'Projekte konnten nicht geladen werden.'));
    } finally {
      this.loading.set(false);
    }
  }

  async selectProject(slug: string): Promise<void> {
    await this.loadProject(slug);
  }

  async loadProject(slug: string): Promise<void> {
    const version = ++this.requestVersion;
    this.activeProject.set(slug);
    this.openAgent.set(null);
    this.loading.set(true);
    this.notice.set('');
    const project = this.projects().find((entry) => entry.slug === slug);
    this.settings = {
      repository: project?.repository ?? '',
      gitRemote: project?.gitRemote ?? '',
      description: project?.description ?? '',
      guidelines: project?.guidelines ?? '',
      testCommands: (project?.testCommands ?? []).map((command) => command.join(' ')).join('\n'),
    };
    if (!slug) {
      this.data.set(emptyProjectData());
      this.loading.set(false);
      return;
    }
    const base = this.api.projectPath(slug);
    const results = await Promise.allSettled([
      this.api.get<{ ideas?: Idea[]; development?: DevelopmentItem[]; comments?: IdeaComment[] }>(`${base}/board`),
      this.api.get<{ sprints?: Sprint[] }>(`${base}/sprints`),
      this.api.get<{ agents?: Agent[] }>(`${base}/agents`),
      this.api.get<{ runs?: ProjectData['agentRuns'] }>(`${base}/agent-runs`),
      this.api.get<{ runs?: TestRun[] }>(`${base}/test-runs`),
      this.api.get<ProjectStats>(`${base}/stats`),
      this.api.get<{ bugs?: Bug[] }>(`${base}/bugs`),
      this.api.get<{ docs?: DocumentEntry[] }>(`${base}/docs`),
      this.api.get<{ reports?: SprintReport[] }>(`${base}/sprint-reports`),
      this.api.get<{ attachments?: Attachment[] }>(`${base}/attachments`),
    ]);
    if (version !== this.requestVersion) return;

    const next = emptyProjectData();
    const errors: Record<string, string> = {};
    const [board, sprints, agents, agentRuns, runs, stats, bugs, docs, reports, attachments] = results;
    if (attachments.status === 'fulfilled') next.attachments = attachments.value.attachments ?? [];
    else errors.attachments = this.errorMessage(attachments.reason, 'Bilder konnten nicht geladen werden.');
    if (board.status === 'fulfilled') {
      next.ideas = board.value.ideas ?? [];
      next.development = board.value.development ?? [];
      next.comments = board.value.comments ?? [];
    } else errors.board = this.errorMessage(board.reason, 'Entwicklungsboard konnte nicht geladen werden.');
    if (sprints.status === 'fulfilled') next.sprints = sprints.value.sprints ?? [];
    else errors.sprints = this.errorMessage(sprints.reason, 'Sprints konnten nicht geladen werden.');
    if (agents.status === 'fulfilled') next.agents = agents.value.agents ?? [];
    else errors.agents = this.errorMessage(agents.reason, 'Agents konnten nicht geladen werden.');
    if (agentRuns.status === 'fulfilled') next.agentRuns = agentRuns.value.runs ?? [];
    else errors.agentRuns = this.errorMessage(agentRuns.reason, 'Agent-Läufe konnten nicht geladen werden.');
    if (runs.status === 'fulfilled') next.runs = runs.value.runs ?? [];
    else errors.runs = this.errorMessage(runs.reason, 'Testläufe konnten nicht geladen werden.');
    if (stats.status === 'fulfilled') next.stats = stats.value;
    else errors.stats = this.errorMessage(stats.reason, 'Statistiken konnten nicht geladen werden.');
    if (bugs.status === 'fulfilled') next.bugs = bugs.value.bugs ?? [];
    else errors.bugs = this.errorMessage(bugs.reason, 'Bugs konnten nicht geladen werden.');
    if (docs.status === 'fulfilled') next.docs = docs.value.docs ?? [];
    else errors.docs = this.errorMessage(docs.reason, 'Dokumente konnten nicht geladen werden.');
    if (reports.status === 'fulfilled') next.reports = reports.value.reports ?? [];
    else errors.reports = this.errorMessage(reports.reason, 'Sprintberichte konnten nicht geladen werden.');

    this.data.set(this.reconcileData(next));
    this.errors.set(errors);
    if (!this.selectedDoc() || !next.docs.some((doc) => doc.id === this.selectedDoc()?.id)) {
      this.selectedDoc.set(next.docs[0] ?? null);
    }
    this.loading.set(false);
    if (Object.keys(errors).length) {
      this.notice.set(`Einige Bereiche konnten nicht geladen werden: ${Object.keys(errors).join(', ')}.`);
    }
    void this.refreshWorker();
  }

  async createProject(): Promise<void> {
    await this.perform(async () => {
      const result = await this.api.post<{ project: Project }>('/api/projects', {
        slug: this.projectForm.slug.trim(),
        name: this.projectForm.name.trim(),
        repository: this.projectForm.repository.trim(),
      });
      if (this.projectForm.gitRemote.trim()) {
        await this.api.patch(`/api/projects/${encodeURIComponent(result.project.slug)}`, {
          gitRemote: this.projectForm.gitRemote.trim(),
        });
      }
      this.projectForm = { name: '', slug: '', repository: '', gitRemote: '' };
      this.showProjectForm.set(false);
      await this.loadProjects(result.project.slug);
    }, 'Projekt wurde gespeichert.', false);
  }

  async saveSettings(): Promise<void> {
    const slug = this.activeProject();
    await this.perform(async () => {
      const result = await this.api.patch<{ project: Project }>(`/api/projects/${encodeURIComponent(slug)}`, {
        repository: this.settings.repository.trim(),
        gitRemote: this.settings.gitRemote.trim(),
        testCommands: this.settings.testCommands,
        description: this.settings.description,
        guidelines: this.settings.guidelines,
      });
      this.projects.update((projects) => projects.map((project) => project.slug === slug
        ? { ...project, ...result.project }
        : project));
      await this.loadProject(slug);
    }, 'Projekteinstellungen gespeichert.', false);
  }

  async createDevelopment(): Promise<void> {
    await this.perform(async () => {
      await this.api.post(`${this.api.projectPath(this.activeProject())}/development`, this.developmentForm);
      this.developmentForm = { title: '', priority: 'medium' };
      this.showCreate.set(false);
    }, 'Entwicklungsauftrag hinzugefügt.');
  }

  async saveDevelopment(item: DevelopmentItem, values: FormValues): Promise<void> {
    await this.perform(() => this.api.patch(`/api/development/${encodeURIComponent(item.id)}`, {
      title: String(values['title'] ?? ''),
      description: String(values['description'] ?? ''),
      priority: values['priority'],
      ...this.estimateValues(values),
    }), 'Auftrag gespeichert.');
  }

  async updateDevelopment(id: string, values: Partial<DevelopmentItem>): Promise<void> {
    await this.perform(() => this.api.patch(`/api/development/${encodeURIComponent(id)}`, values), 'Auftrag aktualisiert.');
  }

  async createIdea(): Promise<void> {
    const { title, description, priority } = this.ideaForm;
    const files = this.pendingImages;
    await this.perform(async () => {
      const created = await this.api.post<{ item: Idea }>(`${this.api.projectPath(this.activeProject())}/ideation`, {
        title, description, priority,
      });
      this.pendingImages = [];
      await this.uploadImages(created.item.id, files);
      this.ideaForm = { title: '', description: '', priority: 'medium' };
      this.showCreate.set(false);
    }, 'Idee wurde hinzugefügt.');
  }

  pendingImageNames(): string {
    return this.pendingImages.map((file) => file.name).join(', ');
  }

  selectPendingImages(input: HTMLInputElement): void {
    this.pendingImages = [...this.pendingImages, ...Array.from(input.files ?? [])];
    input.value = '';
  }

  linkedOrder(ideationId: string): DevelopmentItem | undefined {
    return this.data().development.find((item) => item.ideationId === ideationId);
  }

  imagesOf(ideationId: string | null | undefined): Attachment[] {
    return ideationId ? this.data().attachments.filter((image) => image.ideationId === ideationId) : [];
  }

  imageUrl(image: Attachment): string {
    return this.api.url(`/api/attachments/${encodeURIComponent(image.id)}`);
  }

  editIdea(id: string): void {
    this.ideaEditing.set(true);
    this.openIdea.set(id);
  }

  closeIdea(): void {
    this.openIdea.set(null);
    this.ideaEditing.set(false);
  }

  ideaCellValue(idea: Idea, key: 'status' | 'priority' | 'effortHours' | 'createdAt'): string {
    switch (key) {
      case 'status': return this.statusLabel(idea.status);
      case 'priority': return this.priorityLabel(idea.priority);
      case 'effortHours': return this.hours(idea.effortHours);
      default: return idea.createdAt.slice(0, 10).split('-').reverse().join('.');
    }
  }

  ideaOptions(key: 'status' | 'priority' | 'effortHours' | 'createdAt'): string[] {
    return [...new Set(this.data().ideas.filter((idea) => !this.isClosedIdea(idea)).map((idea) => this.ideaCellValue(idea, key)))].sort();
  }

  isTextColumn(key: IdeaSortKey): key is 'title' | 'description' {
    return key === 'title' || key === 'description';
  }

  setIdeaText(key: 'title' | 'description', value: string): void {
    this.ideaTextFilter.update((filter) => ({ ...filter, [key]: value }));
  }

  toggleIdeaValue(key: 'status' | 'priority' | 'effortHours' | 'createdAt', value: string, checked: boolean): void {
    this.ideaValueFilter.update((filter) => {
      const current = filter[key] ?? [];
      return { ...filter, [key]: checked ? [...current, value] : current.filter((entry) => entry !== value) };
    });
  }

  ideaFilterActive(key: IdeaSortKey): boolean {
    return this.isTextColumn(key) ? !!this.ideaTextFilter()[key] : !!this.ideaValueFilter()[key]?.length;
  }

  clearIdeaFilters(): void {
    this.ideaTextFilter.set({});
    this.ideaValueFilter.set({ ...this.defaultIdeaFilter });
  }

  hasIdeaFilters(): boolean {
    const text = Object.values(this.ideaTextFilter()).some(Boolean);
    const values = this.ideaValueFilter();
    const keys = (Object.keys(values) as (keyof typeof values)[]).filter((key) => values[key]?.length);
    const sameAsDefault = keys.length === 1 && keys[0] === 'status'
      && values.status!.length === this.defaultIdeaFilter.status.length
      && this.defaultIdeaFilter.status.every((label) => values.status!.includes(label));
    return text || (keys.length > 0 && !sameAsDefault);
  }

  isClosedIdea(idea: Idea): boolean {
    return idea.status === 'accepted' || idea.status === 'rejected';
  }

  closedIdeaOrder(idea: Idea): DevelopmentItem | null {
    return this.data().development.find((item) => item.ideationId === idea.id) ?? null;
  }

  sprintOf(item: DevelopmentItem | null): Sprint | null {
    return item?.sprintId ? this.data().sprints.find((sprint) => sprint.id === item.sprintId) ?? null : null;
  }

  readonly devColumns: { key: DevKey; label: string }[] = [
    { key: 'title', label: 'Titel' }, { key: 'description', label: 'Kurzfassung' }, { key: 'status', label: 'Status' },
    { key: 'priority', label: 'Priorität' }, { key: 'sprint', label: 'Sprint' }, { key: 'effortHours', label: 'Aufwand' },
  ];
  readonly devText = signal<Partial<Record<'title' | 'description', string>>>({});
  readonly devValues = signal<Partial<Record<'status' | 'priority' | 'sprint' | 'effortHours', string[]>>>({});
  readonly devSort = signal<{ key: DevKey; dir: 'asc' | 'desc' }>({ key: 'priority', dir: 'desc' });
  readonly openOrder = signal<string | null>(null);
  readonly openSteps = signal<ReadonlySet<string>>(new Set());
  toggleStep(id: string): void {
    this.openSteps.update((set) => { const next = new Set(set); if (!next.delete(id)) next.add(id); return next; });
  }
  stepSummary(content: string): { text: string; bad: boolean }[] {
    const lines = content.split('\n').map((line) => line.trim()).filter(Boolean);
    const results = lines.filter((line) => /^\$ .*→/.test(line)).map((line) => ({ text: line.replace(/^\$ /, ''), bad: /failed/i.test(line) }));
    if (results.length) return results.slice(0, 6);
    const text = lines.slice(0, 2).join(' ');
    return [{ text: text.length > 220 ? `${text.slice(0, 220)} …` : text, bad: false }];
  }
  readonly showDoneOrders = signal(false);
  readonly doneOrders = computed(() => this.data().development.filter((item) => item.status === 'done'));
  readonly openOrders = computed(() => {
    const text = this.devText();
    const values = this.devValues();
    const { key, dir } = this.devSort();
    const rank = (item: DevelopmentItem): string | number | null => {
      switch (key) {
        case 'priority': return ['low', 'medium', 'high'].indexOf(item.priority);
        case 'effortHours': return item.effortHours ?? null;
        case 'status': return this.developmentStatuses.indexOf(item.status);
        case 'sprint': return this.devCell(item, 'sprint').toLowerCase();
        default: return (item[key] ?? '').toString().toLowerCase();
      }
    };
    const factor = dir === 'asc' ? 1 : -1;
    return this.data().development
      .filter((item) => item.status !== 'done')
      .filter((item) => (['title', 'description'] as const).every((field) => !text[field] || (item[field] ?? '').toLowerCase().includes(text[field]!.toLowerCase()))
        && (Object.keys(values) as (keyof typeof values)[]).every((field) => !values[field]?.length || values[field]!.includes(this.devCell(item, field))))
      .sort((a, b) => {
        const x = rank(a), y = rank(b);
        if (x === y) return 0;
        if (x === null) return 1;
        if (y === null) return -1;
        return (x < y ? -1 : 1) * factor;
      });
  });

  devCell(item: DevelopmentItem, key: 'status' | 'priority' | 'sprint' | 'effortHours'): string {
    switch (key) {
      case 'status': return this.statusLabel(item.status);
      case 'priority': return this.priorityLabel(item.priority);
      case 'sprint': return this.sprintOf(item)?.name ?? 'Kein Sprint';
      default: return this.hours(item.effortHours);
    }
  }

  devOptions(key: 'status' | 'priority' | 'sprint' | 'effortHours'): string[] {
    return [...new Set(this.data().development.filter((item) => item.status !== 'done').map((item) => this.devCell(item, key)))].sort();
  }

  isDevText(key: DevKey): key is 'title' | 'description' {
    return key === 'title' || key === 'description';
  }

  devFilterActive(key: DevKey): boolean {
    return this.isDevText(key) ? !!this.devText()[key] : !!this.devValues()[key]?.length;
  }

  hasDevFilters(): boolean {
    return this.devColumns.some((col) => this.devFilterActive(col.key));
  }

  clearDevFilters(): void {
    this.devText.set({});
    this.devValues.set({});
  }

  setDevText(key: 'title' | 'description', value: string): void {
    this.devText.update((filter) => ({ ...filter, [key]: value }));
  }

  toggleDevValue(key: 'status' | 'priority' | 'sprint' | 'effortHours', value: string, checked: boolean): void {
    this.devValues.update((filter) => {
      const current = filter[key] ?? [];
      return { ...filter, [key]: checked ? [...current, value] : current.filter((entry) => entry !== value) };
    });
  }

  sortDevBy(key: DevKey): void {
    this.devSort.update((sort) => ({ key, dir: sort.key === key && sort.dir === 'asc' ? 'desc' : 'asc' }));
  }

  ideaOf(item: DevelopmentItem): Idea | null {
    return item.ideationId ? this.data().ideas.find((idea) => idea.id === item.ideationId) ?? null : null;
  }

  sortIdeasBy(key: IdeaSortKey): void {
    this.ideaSort.update((sort) => ({ key, dir: sort.key === key && sort.dir === 'asc' ? 'desc' : 'asc' }));
  }

  shortText(text: string | null | undefined, limit = 200): string {
    const value = (text ?? '').trim();
    return value.length > limit ? `${value.slice(0, limit).trimEnd()}...` : value;
  }

  async saveIdea(idea: Idea, values: FormValues): Promise<void> {
    await this.perform(() => this.api.patch(`/api/ideation/${encodeURIComponent(idea.id)}`, {
      title: String(values['title'] ?? ''),
      description: String(values['description'] ?? ''),
      ...(this.ideaSelectableStatuses.includes(idea.status) ? { status: values['status'] } : {}),
      priority: values['priority'],
    }), 'Idee gespeichert.');
    this.ideaEditing.set(false);
  }

  async promoteIdea(idea: Idea): Promise<void> {
    await this.perform(() => this.api.post(`/api/ideation/${encodeURIComponent(idea.id)}/define`), 'Der Agent formuliert den Auftrag aus.');
  }

  async startWithAgent(item: DevelopmentItem): Promise<void> {
    const agentId = this.manualAgent[item.id] || item.agentId;
    if (!agentId) return;
    await this.perform(() => this.api.patch(`/api/development/${encodeURIComponent(item.id)}`, { agentId }), 'Agent gestartet – der Worker übernimmt beim nächsten Zyklus.');
    delete this.manualAgent[item.id];
  }

  commentsOf(ideationId: string): IdeaComment[] {
    return this.data().comments.filter((comment) => comment.ideationId === ideationId);
  }

  async addComment(ideationId: string, input: HTMLInputElement): Promise<void> {
    const body = input.value.trim();
    if (!body) return;
    await this.perform(() => this.api.post(`/api/ideation/${encodeURIComponent(ideationId)}/comments`, { body }), 'Kommentar gespeichert.');
    input.value = '';
  }

  statusOptions(idea: Idea): string[] {
    return this.ideaSelectableStatuses.includes(idea.status) ? this.ideaSelectableStatuses : [idea.status];
  }

  async createSprint(): Promise<void> {
    const body = {
      name: this.sprintForm.name,
      goal: this.sprintForm.goal,
      startDate: this.sprintForm.startDate || null,
      endDate: this.sprintForm.endDate || null,
    };
    await this.perform(async () => {
      await this.api.post(`${this.api.projectPath(this.activeProject())}/sprints`, body);
      this.sprintForm = { name: '', goal: '', startDate: '', endDate: '' };
      this.showCreate.set(false);
    }, 'Sprint angelegt.');
  }

  async updateSprint(id: string, values: Partial<Sprint>): Promise<void> {
    await this.perform(() => this.api.patch(`/api/sprints/${encodeURIComponent(id)}`, values), 'Sprint aktualisiert.');
  }

  async deleteSprint(id: string): Promise<void> {
    if (!globalThis.confirm('Sprint löschen? Die Aufträge bleiben im Backlog erhalten.')) return;
    await this.perform(() => this.api.delete(`/api/sprints/${encodeURIComponent(id)}`), 'Sprint gelöscht.');
  }

  async retryGitSync(id: string): Promise<void> {
    await this.perform(() => this.api.post(`/api/sprints/${encodeURIComponent(id)}/git-sync`), 'Git-Sicherung wird erneut ausgeführt.');
  }

  async refreshReport(id: string): Promise<void> {
    await this.perform(() => this.api.post(`/api/sprints/${encodeURIComponent(id)}/report`), 'Sprintbericht aktualisiert.');
  }

  async saveReportNotes(id: string, notes: string): Promise<void> {
    await this.perform(() => this.api.patch(`/api/sprints/${encodeURIComponent(id)}/report`, { notes }), 'Sprintbericht-Notizen gespeichert.');
  }

  async createBug(): Promise<void> {
    const body = { ...this.bugForm, sprintId: this.bugForm.sprintId || null };
    await this.perform(async () => {
      await this.api.post(`${this.api.projectPath(this.activeProject())}/bugs`, body);
      this.bugForm = { title: '', description: '', severity: 'medium', sprintId: '' };
      this.showCreate.set(false);
    }, 'Bug wurde gemeldet.');
  }

  async saveBug(bug: Bug, values: FormValues): Promise<void> {
    await this.perform(() => this.api.patch(`/api/bugs/${encodeURIComponent(bug.id)}`, {
      title: String(values['title'] ?? ''),
      description: String(values['description'] ?? ''),
      severity: values['severity'],
      sprintId: values['sprintId'] || null,
      fixNotes: String(values['fixNotes'] ?? ''),
    }), 'Bug wurde gespeichert.');
  }

  async updateBug(id: string, values: Partial<Bug>): Promise<void> {
    await this.perform(() => this.api.patch(`/api/bugs/${encodeURIComponent(id)}`, values), 'Bug aktualisiert.');
  }

  async deleteBug(id: string): Promise<void> {
    if (!globalThis.confirm('Bug löschen?')) return;
    await this.perform(() => this.api.delete(`/api/bugs/${encodeURIComponent(id)}`), 'Bug gelöscht.');
  }

  async createDocument(): Promise<void> {
    await this.perform(async () => {
      await this.api.post(`${this.api.projectPath(this.activeProject())}/docs`, this.docForm);
      this.docForm = { title: '', content: '' };
      this.showCreate.set(false);
    }, 'Dokument gespeichert.');
  }

  async saveDocument(doc: DocumentEntry, values: FormValues): Promise<void> {
    await this.perform(() => this.api.patch(`/api/docs/${encodeURIComponent(doc.id)}`, {
      title: String(values['title'] ?? ''),
      content: String(values['content'] ?? ''),
    }), 'Dokument gespeichert.');
  }

  async deleteDocument(id: string): Promise<void> {
    if (!globalThis.confirm('Dokument löschen?')) return;
    await this.perform(async () => {
      await this.api.delete(`/api/docs/${encodeURIComponent(id)}`);
      if (this.selectedDoc()?.id === id) this.selectedDoc.set(null);
    }, 'Dokument gelöscht.');
  }

  async createAgent(): Promise<void> {
    let command: string[] | null;
    try {
      command = this.parseCommand(this.agentForm.command);
    } catch (error) {
      this.notice.set(this.errorMessage(error, 'Der Agent-Befehl ist ungültig.'));
      return;
    }
    await this.perform(async () => {
      await this.api.post(`${this.api.projectPath(this.activeProject())}/agents`, {
        ...this.agentForm,
        command,
      });
      this.agentForm = { name: '', role: 'developer', phase: 'while_task', command: '', instructions: '' };
      this.showCreate.set(false);
    }, 'Agent angelegt.');
  }

  async createDefaultAgents(): Promise<void> {
    await this.perform(() => this.api.post(`${this.api.projectPath(this.activeProject())}/agents/defaults`), 'Standard-Workflow angelegt.');
  }

  async updateAgent(id: string, values: Partial<Agent>): Promise<void> {
    await this.perform(() => this.api.patch(`/api/agents/${encodeURIComponent(id)}`, values), 'Agent aktualisiert.');
  }

  async deleteAgent(id: string): Promise<void> {
    if (!globalThis.confirm('Agent löschen?')) return;
    await this.perform(() => this.api.delete(`/api/agents/${encodeURIComponent(id)}`), 'Agent gelöscht.');
  }

  async moveAgent(agent: Agent, direction: -1 | 1): Promise<void> {
    const ids = this.data().agents.filter((item) => item.phase === agent.phase).map((item) => item.id);
    const index = ids.indexOf(agent.id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= ids.length) return;
    [ids[index], ids[nextIndex]] = [ids[nextIndex]!, ids[index]!];
    await this.perform(() => this.api.post(`${this.api.projectPath(this.activeProject())}/agents/order`, {
      phase: agent.phase,
      ids,
    }), 'Reihenfolge gespeichert.');
  }

  navCount(section: Section): number {
    const data = this.data();
    switch (section) {
      case 'dashboard': return 0;
      case 'development': return data.development.filter((item) => item.status !== 'done').length;
      case 'sprints': return data.sprints.length;
      case 'ideation': return data.ideas.filter((idea) => idea.status !== 'rejected').length;
      case 'bugs': return data.bugs.filter((bug) => bug.status === 'open' || bug.status === 'in_progress').length;
      case 'docs': return data.docs.length;
      case 'agents': return data.agents.length;
      case 'runs': return data.runs.length;
      case 'settings': return 0;
    }
  }

  createLabel(): string {
    const labels: Record<string, string> = {
      development: 'Neuer Auftrag', ideation: 'Neue Idee', sprints: 'Neuer Sprint', bugs: 'Neuer Bug', docs: 'Neues Handbuch',
    };
    return this.section() === 'agents' && this.selectedAgent() ? '' : this.section() === 'agents' ? 'Neuer Agent' : labels[this.section()] ?? '';
  }

  activeSectionLabel(): string {
    return SECTION_LABELS[this.section()];
  }

  async showAgent(id: string): Promise<void> {
    this.navigate('agents');
    this.openAgent.set(id);
    this.agentActivity.set([]);
    this.agentUpcoming.set([]);
    this.agentActivityLoading.set(true);
    try {
      const result = await this.api.get<{ activity: AgentActivity[]; upcoming: UpcomingTask[] }>(`${this.api.projectPath(this.activeProject())}/agents/${encodeURIComponent(id)}/activity`);
      if (this.openAgent() === id) {
        this.agentActivity.set(result.activity);
        this.agentUpcoming.set(result.upcoming ?? []);
      }
    } catch (error) {
      this.notice.set(this.errorMessage(error, 'Aufgaben des Agents konnten nicht geladen werden.'));
    } finally {
      this.agentActivityLoading.set(false);
    }
  }

  closeAgent(): void {
    this.openAgent.set(null);
  }

  activeAgentCount(): number {
    return this.worker().agents.filter((agent) => agent.active).length;
  }

  workerText(): string {
    if (this.workerFailure()) return 'Worker-Status nicht abrufbar';
    const worker = this.worker();
    if (!worker.online) return worker.worker ? 'Worker offline' : 'Worker nicht gestartet';
    if (worker.running.length) return `Worker arbeitet: ${worker.running[0]!.title}`;
    return 'Worker bereit';
  }

  openDevelopmentCount(): number {
    return this.data().development.filter((item) => item.status !== 'done').length;
  }

  openIdeasCount(): number {
    return this.data().ideas.filter((idea) => !['accepted', 'rejected'].includes(idea.status)).length;
  }

  openBugCount(): number {
    return this.data().bugs.filter((bug) => bug.status === 'open' || bug.status === 'in_progress').length;
  }

  ratedIdeas(): Idea[] {
    return this.data().ideas.filter((idea) => idea.benefit !== null && idea.benefit !== undefined
      && idea.cost !== null && idea.cost !== undefined);
  }

  barWidth(value: number, maximum: number): number {
    return maximum ? Math.max(0, Math.min(100, (value / maximum) * 100)) : 0;
  }

  dateLabel(value: string): string {
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  }

  maxVelocity(): number {
    return Math.max(1, ...((this.data().stats?.velocity ?? []).map((sprint) => sprint.total)));
  }

  maxAgentRuns(): number {
    return Math.max(1, ...((this.data().stats?.agents ?? []).map((agent) => agent.passed + agent.failed + agent.skipped)));
  }

  maxSeverityCount(): number {
    return Math.max(1, ...Object.values(this.data().stats?.openBugsBySeverity ?? {}));
  }

  availableSprints(): Sprint[] {
    return this.data().sprints.filter((sprint) => sprint.status !== 'completed');
  }

  visibleBugs(): Bug[] {
    const filter = this.bugFilter();
    return this.data().bugs.filter((bug) => filter === 'all' || bug.status === filter);
  }

  docsOfKind(kind: DocumentEntry['kind']): DocumentEntry[] {
    return this.data().docs.filter((doc) => doc.kind === kind);
  }

  agentsOfPhase(phase: AgentPhase): Agent[] {
    return this.data().agents.filter((agent) => agent.phase === phase);
  }

  reportFor(sprintId: string): SprintReport | undefined {
    return this.data().reports.find((report) => report.sprintId === sprintId);
  }

  sprintProgress(sprintId: string): string {
    const orders = this.data().development.filter((item) => item.sprintId === sprintId);
    const done = orders.filter((item) => item.status === 'done').length;
    return `${done} / ${orders.length} Aufträge erledigt`;
  }

  statusLabel(status: string): string {
    const labels: Record<string, string> = {
      running: 'Läuft', passed: 'Bestanden', failed: 'Fehlgeschlagen', skipped: 'Übersprungen',
      idea: 'Idee', considering: 'In Abklärung', requested: 'Wird ausformuliert', drafting: 'Wird ausformuliert',
      accepted: 'Auftrag erstellt', rejected: 'Verworfen', backlog: 'Backlog', planned: 'Geplant',
      in_progress: 'In Arbeit', blocked: 'Blockiert', done: 'Erledigt', open: 'Offen', fixed: 'Behoben',
      wontfix: 'Kein Fix', active: 'Aktiv', completed: 'Abgeschlossen',
    };
    return labels[status] ?? status;
  }

  statusClass(status: string): string {
    return `status-${status}`;
  }

  priorityLabel(priority: string): string {
    return ({ low: 'Niedrig', medium: 'Mittel', high: 'Hoch' } as Record<string, string>)[priority] ?? priority;
  }

  severityLabel(severity: string): string {
    return ({ low: 'Niedrig', medium: 'Mittel', high: 'Hoch', critical: 'Kritisch' } as Record<string, string>)[severity] ?? severity;
  }

  roleLabel(role: string): string {
    return this.agentRoles.find((item) => item.value === role)?.label ?? role;
  }

  documentKindLabel(kind: DocumentEntry['kind']): string {
    return this.documentGroups.find((item) => item.kind === kind)?.label ?? kind;
  }

  hours(value: number | null | undefined): string {
    return value === null || value === undefined ? '–' : `${Number(value).toLocaleString('de-DE', { maximumFractionDigits: 1 })} h`;
  }

  number(value: number | null | undefined): string {
    return Number(value ?? 0).toLocaleString('de-DE');
  }

  dateTime(value: string | null | undefined): string {
    if (!value) return '–';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '–' : date.toLocaleString('de-DE');
  }

  duration(value: number | null | undefined): string {
    const milliseconds = Number(value ?? 0);
    if (milliseconds >= 60_000) return `${(milliseconds / 60_000).toFixed(1)} min`;
    if (milliseconds >= 1000) return `${(milliseconds / 1000).toFixed(1)} s`;
    return `${milliseconds} ms`;
  }

  async saveMaxAgents(): Promise<void> {
    await this.perform(async () => {
      await this.api.put('/api/settings', { maxConcurrentAgents: Number(this.maxAgents) });
      await this.refreshAgentStatus(true);
    }, 'Anzahl gleichzeitiger Agents gespeichert.', false);
  }

  projectName(slug: string): string {
    return this.projects().find((project) => project.slug === slug)?.name ?? slug;
  }

  private async refreshAgentStatus(syncForm = false): Promise<void> {
    try {
      const status = await this.api.get<AgentStatus>('/api/agent-status');
      this.agentStatus.set(status);
      if (syncForm) this.maxAgents = status.maxConcurrentAgents;
    } catch {
      // the topbar already reports an unreachable worker
    }
  }

  private async refreshWorker(): Promise<void> {
    void this.refreshAgentStatus();
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

  private async perform(action: () => Promise<unknown>, success: string, refresh = true): Promise<void> {
    this.busy.set(true);
    this.notice.set('');
    try {
      await action();
      if (refresh && this.activeProject()) await this.loadProject(this.activeProject());
      this.notice.set(success);
    } catch (error) {
      this.notice.set(this.errorMessage(error, 'Aktion fehlgeschlagen.'));
    } finally {
      this.busy.set(false);
    }
  }

  private async uploadImages(ideationId: string, files: File[]): Promise<void> {
    for (const file of files) {
      if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name} ist größer als 5 MB.`);
      await this.api.upload(`/api/ideation/${encodeURIComponent(ideationId)}/attachments`, file);
    }
  }

  private estimateValues(values: { effortHours?: unknown; tokenEstimate?: unknown; benefit?: unknown; cost?: unknown }): Estimate {
    const numberOrNull = (value: unknown): number | null => {
      if (value === '' || value === null || value === undefined) return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    };
    const source = values;
    return {
      effortHours: numberOrNull(source['effortHours']),
      tokenEstimate: numberOrNull(source['tokenEstimate']),
      benefit: numberOrNull(source['benefit']),
      cost: numberOrNull(source['cost']),
    };
  }

  private parseCommand(text: string): string[] | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('[')) {
      const value: unknown = JSON.parse(trimmed);
      if (Array.isArray(value) && value.every((part: unknown) => typeof part === 'string')) return value;
      throw new Error('Der Befehl im JSON-Format muss ein Array aus Textwerten sein.');
    }
    return trimmed.split(/\s+/);
  }

  private reconcileData(data: ProjectData): ProjectData {
    const bugIds = new Set(data.bugs.map((bug) => bug.id));
    const development = data.development.filter((item) => !item.bugId || bugIds.has(item.bugId));
    return { ...data, development };
  }

  private sectionFromHash(): Section {
    const section = globalThis.location.hash.slice(1);
    return this.isSection(section) ? section : 'dashboard';
  }

  private isSection(section: string): section is Section {
    return this.navigation.some((item) => item.id === section);
  }

  private errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
  }
}
