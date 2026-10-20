import { Component, computed, effect, inject, OnDestroy, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import type { Project } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { SetupService } from '../../core/setup.service.js';
import { type CheckState, CheckStateComponent } from '../../shared/check-state.component.js';
import { MarkdownPipe } from '../../shared/markdown.pipe.js';

interface FolderInfo {
  exists: boolean;
  isDirectory: boolean;
  empty: boolean;
  entries?: string[];
  git: { isRepo: boolean; branch: string | null; remote: string | null; commits: number } | null;
}
interface GithubInfo {
  gh: { installed: boolean; authenticated: boolean; user: string | null };
  ssh: { ok: boolean; user: string | null; message: string | null };
}
interface TemplateInfo {
  id: string;
  label: string;
  description: string;
  group: 'featured' | 'frontend' | 'fullstack' | 'backend' | 'other';
  stack: string[];
}
interface PermissionInfo {
  id: string;
  label: string;
  description: string;
}
type GitMode = 'github-new' | 'github-existing' | 'local' | 'none' | 'keep';
type Provider = 'ollama' | 'claude' | 'copilot' | 'gemini';

const STEPS = ['Projekt', 'Git & Vorlage', 'Agents', 'Rechte'] as const;
/** Überschrift und Kurzbeschreibung je Schritt für Seitenleiste und Kopf. */
const STEP_INFO = [
  { title: 'Wie heißt dein Projekt?', hint: 'Name und Ordner' },
  { title: 'Versionierung & Vorlage', hint: 'Git, GitHub, Startcode' },
  { title: 'Wer arbeitet für dich?', hint: 'Modell und Verbindung' },
  { title: 'Was dürfen die Agents?', hint: 'Freigaben ohne Rückfrage' },
] as const;
const CHECK_DELAY_MS = 450;

export const PROVIDERS: { id: Provider; label: string; paid: boolean; models: { id: string; label: string }[] }[] = [
  { id: 'ollama', label: 'Lokal (Ollama)', paid: false, models: [] },
  {
    id: 'claude',
    label: 'Claude',
    paid: true,
    models: [
      { id: 'haiku', label: 'Claude Haiku – schnell, günstig' },
      { id: 'sonnet', label: 'Claude Sonnet – ausgewogen' },
      { id: 'opus', label: 'Claude Opus – am stärksten' },
    ],
  },
  { id: 'copilot', label: 'GitHub Copilot', paid: true, models: [{ id: '', label: 'Standardmodell' }] },
  {
    id: 'gemini',
    label: 'Gemini',
    paid: true,
    models: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash – schnell' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro – stark' },
    ],
  },
];

/** Einrichtungshilfe je Anbieter (macOS). */
export const PROVIDER_HELP: Record<Provider, { install: string; login: string; note: string }> = {
  ollama: {
    install: 'brew install ollama   # oder App von ollama.com',
    login: 'ollama serve & ollama pull qwen3.5:9b',
    note: 'Kostenlos und lokal. Läuft auf deinem Rechner, Qualität abhängig vom Modell.',
  },
  claude: {
    install: 'curl -fsSL https://claude.ai/install.sh | bash',
    login: 'claude   # im Terminal starten und /login ausführen',
    note: 'Claude-Abo (Pro/Max) oder API-Schlüssel nötig.',
  },
  copilot: {
    install: 'npm install -g @github/copilot',
    login: 'copilot   # im Terminal starten und /login ausführen',
    note: 'Aktives GitHub-Copilot-Abo nötig.',
  },
  gemini: {
    install: 'npm install -g @google/gemini-cli',
    login: 'gemini   # im Terminal starten und mit Google anmelden',
    note: 'Google-Konto; kostenloses Kontingent oder API-Schlüssel.',
  },
};

const slugify = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);

/** Geführtes Anlegen eines Projekts: Ordner prüfen, Git/GitHub und Vorlage, Agent-Anbieter testen, Rechte wählen. */
@Component({
  selector: 'app-project-wizard',
  standalone: true,
  imports: [FormsModule, CheckStateComponent, MarkdownPipe],
  templateUrl: './project-wizard.component.html',
  host: { style: 'display: contents' },
})
export class ProjectWizardComponent implements OnDestroy {
  private readonly api = inject(ApiService);
  private readonly setup = inject(SetupService);
  private readonly store = inject(ProjectStore);
  readonly closed = output<void>();
  /** Projekt wurde angelegt (Slug) – die App bietet danach die Tour an. */
  readonly projectCreated = output<string>();

  protected readonly steps = STEPS;
  protected readonly stepInfo = STEP_INFO;
  /** Hilfe-Chat als ausklappbares Panel statt fester Spalte. */
  protected readonly helpOpen = signal(false);
  protected readonly providers = PROVIDERS;
  protected readonly help = PROVIDER_HELP;
  protected readonly step = signal(0);

  // Schritt 1: Projekt und Ordner
  protected readonly name = signal('');
  protected readonly slugInput = signal('');
  protected readonly slugTouched = signal(false);
  protected readonly folder = signal('');
  /** Bis der Ordner von Hand geändert wird, folgt er dem Projektbereich + Projekt-ID. */
  protected readonly folderTouched = signal(false);
  /** Projektbereich (DEV_LOG_PROJECT_ROOTS): nur hier legt AIdeation Ordner an. */
  protected readonly scopeRoots = signal<string[]>([]);
  protected readonly folderState = signal<CheckState>('idle');
  protected readonly folderInfo = signal<FolderInfo | null>(null);
  protected readonly folderError = signal('');
  protected readonly slug = computed(() => slugify(this.slugTouched() ? this.slugInput() : this.name()));
  private folderTimer: ReturnType<typeof setTimeout> | undefined;
  private folderCheck = 0;

  // Schritt 2: Git, GitHub, Vorlage
  protected readonly github = signal<GithubInfo | null>(null);
  protected readonly githubState = signal<CheckState>('idle');
  protected readonly templates = signal<TemplateInfo[]>([]);
  protected readonly templateGroups = signal<Record<string, string>>({});
  protected readonly template = signal<string>('none');
  protected readonly templateUrl = signal('');
  protected readonly gitMode = signal<GitMode>('local');
  protected readonly repoName = signal('');
  protected readonly visibility = signal<'private' | 'public'>('private');
  protected readonly remote = signal('');
  protected readonly gitState = signal<CheckState>('idle');
  protected readonly gitLog = signal('');
  protected readonly gitError = signal('');

  // Schritt 3: Agents
  protected readonly provider = signal<Provider>('claude');
  protected readonly model = signal('sonnet');
  protected readonly agentState = signal<CheckState>('idle');
  protected readonly agentResult = signal<{
    installed?: boolean;
    ok?: boolean;
    output?: string;
    models?: string[];
    model?: string;
  } | null>(null);
  private agentCheck = 0;

  // Schritt 4: Rechte
  protected readonly permissionGroups = signal<PermissionInfo[]>([]);
  protected readonly permissions = signal<string[]>([]);
  protected readonly saving = signal(false);
  protected readonly saveError = signal('');
  protected readonly created = signal<string | null>(null);

  // Hilfe-Assistent
  protected readonly chat = signal<{ role: 'user' | 'assistant'; content: string }[]>([]);
  protected readonly chatInput = signal('');
  protected readonly chatBusy = signal(false);

  protected readonly providerModels = computed(
    () => PROVIDERS.find((entry) => entry.id === this.provider())?.models ?? [],
  );
  protected readonly featured = computed(() =>
    this.templates().filter((entry) => entry.group === 'featured' || entry.id === 'custom'),
  );
  protected readonly moreGroups = computed(() =>
    (['frontend', 'fullstack', 'backend'] as const).map((group) => ({
      label: this.templateGroups()[group] ?? group,
      templates: this.templates().filter((entry) => entry.group === group),
    })),
  );
  protected readonly isMoreTemplate = computed(() =>
    this.moreGroups().some((group) => group.templates.some((entry) => entry.id === this.template())),
  );

  protected readonly canNext = computed(() => {
    switch (this.step()) {
      case 0:
        return (
          !!this.name().trim() &&
          !!this.slug() &&
          (this.folderState() === 'ok' || (this.folderState() === 'warn' && !this.folderError()))
        );
      case 1:
        return this.gitState() === 'ok' || (this.gitMode() === 'none' && this.template() === 'none');
      case 2:
        return this.agentState() === 'ok';
      default:
        return true;
    }
  });

  constructor() {
    void this.api
      .get<{ templates: TemplateInfo[]; groups: Record<string, string> }>('/api/setup/templates')
      .then((result) => {
        this.templates.set(result.templates);
        this.templateGroups.set(result.groups);
      })
      .catch(() => undefined);
    void this.api
      .get<{ groups: PermissionInfo[]; defaults: string[] }>('/api/setup/permissions')
      .then((result) => {
        this.permissionGroups.set(result.groups);
        this.permissions.set(result.defaults);
      })
      .catch(() => undefined);
    void this.api
      .get<{ roots: string[] }>('/api/setup/scope')
      .then((result) => this.scopeRoots.set(result.roots ?? []))
      .catch(() => undefined);
    effect(() => {
      const root = this.scopeRoots()[0];
      const slug = this.slug();
      if (root && !untracked(() => this.folderTouched())) this.folder.set(slug ? `${root}/${slug}/source` : `${root}/`);
    });
    // Ordner in Echtzeit prüfen (verzögert, damit nicht jeder Tastendruck einen Job startet).
    effect(() => {
      const path = this.folder();
      untracked(() => this.scheduleFolderCheck(path));
    });
  }

  ngOnDestroy(): void {
    clearTimeout(this.folderTimer);
  }

  protected setName(value: string): void {
    this.name.set(value);
  }

  protected setFolder(value: string): void {
    this.folderTouched.set(true);
    this.folder.set(value);
  }

  protected setSlug(value: string): void {
    this.slugTouched.set(true);
    this.slugInput.set(value);
  }

  private scheduleFolderCheck(path: string): void {
    clearTimeout(this.folderTimer);
    this.folderInfo.set(null);
    this.folderError.set('');
    if (!path.trim() || path.trim().endsWith('/')) {
      this.folderState.set('idle');
      return;
    }
    this.folderState.set('loading');
    this.folderTimer = setTimeout(() => void this.checkFolder(), CHECK_DELAY_MS);
  }

  protected async checkFolder(): Promise<void> {
    const check = ++this.folderCheck;
    this.folderState.set('loading');
    try {
      const job = await this.setup.run<FolderInfo>('check_folder', { path: this.folder().trim() });
      if (check !== this.folderCheck) return;
      if (job.status === 'failed') {
        this.folderState.set('error');
        this.folderError.set(job.result?.error ?? 'Prüfung fehlgeschlagen.');
        return;
      }
      const info = job.result!;
      this.folderInfo.set(info);
      this.folderState.set(info.exists ? (info.isDirectory ? 'ok' : 'error') : 'warn');
      if (info.exists && !info.isDirectory) this.folderError.set('Der Pfad ist eine Datei, kein Ordner.');
    } catch (error) {
      if (check !== this.folderCheck) return;
      this.folderState.set('error');
      this.folderError.set(error instanceof Error ? error.message : String(error));
    }
  }

  protected async createFolder(): Promise<void> {
    this.folderState.set('loading');
    const job = await this.setup.run('create_folder', { path: this.folder().trim() }).catch(() => null);
    if (job?.status === 'failed') {
      this.folderState.set('error');
      this.folderError.set(job.result?.error ?? 'Ordner konnte nicht angelegt werden.');
      return;
    }
    await this.checkFolder();
  }

  protected async goTo(step: number): Promise<void> {
    if (step > this.step() && !this.canNext()) return;
    // Fehlender Ordner im Projektbereich wird beim Weitergehen angelegt.
    if (this.step() === 0 && step > 0 && this.folderState() === 'warn') {
      await this.createFolder();
      if (this.folderState() !== 'ok') return;
    }
    this.step.set(step);
    if (step === 1) this.enterGitStep();
    if (step === 2 && this.agentState() === 'idle') void this.testAgent();
  }

  private enterGitStep(): void {
    if (!this.repoName()) this.repoName.set(this.slug());
    const git = this.folderInfo()?.git;
    if (git?.isRepo && git.remote) {
      this.gitMode.set('keep');
      this.remote.set(git.remote);
    } else if (git?.isRepo) {
      this.gitMode.set('local');
    }
    if (!this.folderInfo()?.empty) this.template.set('none');
    if (this.githubState() === 'idle') void this.checkGithub();
  }

  protected async checkGithub(): Promise<void> {
    this.githubState.set('loading');
    const job = await this.setup.run<GithubInfo>('check_github').catch(() => null);
    if (!job || job.status === 'failed') {
      this.githubState.set('error');
      return;
    }
    this.github.set(job.result);
    const info = job.result!;
    this.githubState.set(info.gh.authenticated ? 'ok' : info.ssh.ok ? 'warn' : 'error');
    if (this.gitMode() === 'local' && !this.folderInfo()?.git?.isRepo && info.gh.authenticated)
      this.gitMode.set('github-new');
  }

  protected chooseTemplate(id: string): void {
    this.template.set(id);
    this.gitState.set('idle');
  }

  protected chooseMode(mode: GitMode): void {
    this.gitMode.set(mode);
    this.gitState.set('idle');
    this.gitError.set('');
  }

  /** Vorlage anwenden und Git/GitHub einrichten (beides auf dem Rechner, Fortschritt als Protokoll). */
  protected async applyGit(): Promise<void> {
    this.gitState.set('loading');
    this.gitError.set('');
    this.gitLog.set('');
    const path = this.folder().trim();
    let templateLog = '';
    try {
      if (this.template() !== 'none') {
        const job = await this.setup.run(
          'apply_template',
          { path, template: this.template(), templateUrl: this.templateUrl(), name: this.name() },
          (update) => this.gitLog.set(update.log),
        );
        if (job.status === 'failed') throw new Error(job.result?.error ?? 'Vorlage fehlgeschlagen.');
        templateLog = job.log;
      }
      const mode = this.gitMode() === 'keep' ? 'local' : this.gitMode();
      if (mode !== 'none') {
        const job = await this.setup.run<{ remote: string | null }>(
          'git_setup',
          { path, mode, repoName: this.repoName(), visibility: this.visibility(), remote: this.remote() },
          (update) => this.gitLog.set(`${templateLog}${update.log}`),
        );
        if (job.status === 'failed') throw new Error(job.result?.error ?? 'Git-Einrichtung fehlgeschlagen.');
        if (job.result?.remote) this.remote.set(job.result.remote);
      }
      this.gitState.set('ok');
      void this.checkFolder();
    } catch (error) {
      this.gitState.set('error');
      this.gitError.set(error instanceof Error ? error.message : String(error));
    }
  }

  protected chooseProvider(provider: Provider): void {
    this.provider.set(provider);
    this.model.set(PROVIDERS.find((entry) => entry.id === provider)?.models[provider === 'claude' ? 1 : 0]?.id ?? '');
    void this.testAgent();
  }

  protected chooseModel(model: string): void {
    this.model.set(model);
    void this.testAgent();
  }

  /** Testet die gewählte Integration mit einer kurzen Frage. */
  protected async testAgent(): Promise<void> {
    const check = ++this.agentCheck;
    this.agentState.set('loading');
    this.agentResult.set(null);
    const job = await this.setup
      .run<{ installed: boolean; ok: boolean; output?: string; models?: string[]; model?: string }>('test_agent', {
        provider: this.provider(),
        model: this.model(),
      })
      .catch(() => null);
    if (check !== this.agentCheck) return;
    this.agentResult.set(job?.result ?? null);
    this.agentState.set(job?.status === 'done' && job.result?.ok ? 'ok' : 'error');
  }

  protected togglePermission(id: string, checked: boolean): void {
    this.permissions.update((list) => (checked ? [...new Set([...list, id])] : list.filter((entry) => entry !== id)));
  }

  protected async createProject(): Promise<void> {
    this.saving.set(true);
    this.saveError.set('');
    try {
      const result = await this.api.post<{ project: Project }>('/api/projects/setup', {
        name: this.name().trim(),
        slug: this.slug(),
        repository: this.folder().trim(),
        gitRemote: ['github-new', 'github-existing', 'keep'].includes(this.gitMode()) ? this.remote() || null : null,
        agent: { provider: this.provider(), model: this.model() },
        permissions: this.permissions(),
      });
      this.created.set(result.project.slug);
      this.projectCreated.emit(result.project.slug);
      await this.store.loadProjects(result.project.slug);
    } catch (error) {
      this.saveError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected async ask(): Promise<void> {
    const question = this.chatInput().trim();
    if (!question || this.chatBusy()) return;
    this.chat.update((list) => [...list, { role: 'user', content: question }]);
    this.chatInput.set('');
    this.chatBusy.set(true);
    const job = await this.setup
      .run<{ answer: string }>('helper_chat', { messages: this.chat(), step: STEPS[this.step()] })
      .catch(() => null);
    this.chat.update((list) => [
      ...list,
      { role: 'assistant', content: job?.result?.answer ?? 'Der Hilfe-Assistent ist gerade nicht erreichbar.' },
    ]);
    this.chatBusy.set(false);
  }
}
