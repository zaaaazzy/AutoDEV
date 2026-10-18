import { Component, computed, effect, ElementRef, inject, input, signal, viewChild } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import { AuthService } from '../../core/auth.service.js';
import { ProjectStore } from '../../core/project-store.js';

export interface AgentTask {
  id: string;
  title: string;
  prompt: string;
  agentId: string | null;
  agentName: string | null;
  runCount: number;
  lastRunAt: string | null;
}

interface TaskEntry {
  id: string | null;
  title: string;
  prompt: string;
  agentId: string | null;
  agentName: string | null;
  builtIn: boolean;
  runCount: number;
}

/** Vorlagen für häufige Aufgaben; lassen sich direkt starten oder als eigene Aufgabe anpassen. */
const TEMPLATES: { title: string; prompt: string }[] = [
  {
    title: 'Tests ausführen',
    prompt:
      'Führe alle Tests des Projekts aus und fasse das Ergebnis zusammen. Ändere nichts, nenne fehlschlagende Tests mit vermuteter Ursache.',
  },
  {
    title: 'Lint und Typprüfung beheben',
    prompt: 'Führe Linter und Typprüfung aus und behebe die gefundenen Fehler, ohne das Verhalten zu ändern.',
  },
  {
    title: 'Abhängigkeiten prüfen',
    prompt:
      'Prüfe veraltete und unsichere Abhängigkeiten (z. B. npm outdated, npm audit) und schlage Updates mit Risiko vor. Nichts installieren.',
  },
  {
    title: 'Docker-Dienste starten',
    prompt:
      'Starte die Docker-Dienste des Projekts (docker compose up -d) und prüfe, ob alle laufen. Melde Fehler mit einem kurzen Log-Auszug.',
  },
  {
    title: 'Logs auf Fehler prüfen',
    prompt: 'Prüfe die Logs der laufenden Dienste auf Fehler und Warnungen der letzten Stunde und fasse sie zusammen.',
  },
  {
    title: 'Git-Status zusammenfassen',
    prompt:
      'Zeige aktuellen Branch, nicht committete Änderungen und Commits, die noch nicht gepusht sind. Nichts ändern.',
  },
];

const normalize = (value: string) => value.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');

/** Gespeicherte Agent-Aufgaben: per Dropdown suchen und mit einem Klick an den Assistenten übergeben. */
@Component({
  selector: 'app-agent-tasks',
  standalone: true,
  templateUrl: './agent-tasks.component.html',
  host: { class: 'agent-tasks', '(document:click)': 'outside($event)', '(keydown.escape)': 'close()' },
})
export class AgentTasksComponent {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);
  private readonly host = inject(ElementRef<HTMLElement>);
  protected readonly auth = inject(AuthService);
  protected readonly open = signal(false);
  protected readonly query = signal('');
  protected readonly active = signal(0);
  protected readonly tasks = signal<AgentTask[]>([]);
  protected readonly busy = signal(false);
  /** Formular: null = geschlossen, id null = neue Aufgabe. */
  protected readonly editing = signal<{
    id: string | null;
    title: string;
    prompt: string;
    agentId: string | null;
  } | null>(null);
  /** Im Chat gewählter Agent: übernimmt Vorlagen und ist Vorgabe für neue Aufgaben. */
  readonly agentId = input<string | null>(null);
  /** Agents des Projekts, die eine Aufgabe übernehmen können. */
  protected readonly agents = computed(() => this.store.data().agents.filter((agent) => agent.enabled));
  private readonly search = viewChild<ElementRef<HTMLInputElement>>('search');

  protected readonly entries = computed<TaskEntry[]>(() => {
    const own = this.tasks().map((task) => ({ ...task, builtIn: false }));
    const ownTitles = new Set(own.map((task) => normalize(task.title)));
    const templates = TEMPLATES.filter((template) => !ownTitles.has(normalize(template.title))).map((template) => ({
      ...template,
      id: null,
      agentId: null,
      agentName: null,
      builtIn: true,
      runCount: 0,
    }));
    const terms = normalize(this.query()).split(/\s+/).filter(Boolean);
    return [...own, ...templates].filter((entry) => {
      const text = normalize(`${entry.title} ${entry.prompt}`);
      return terms.every((term) => text.includes(term));
    });
  });
  protected readonly ownCount = computed(() => this.entries().filter((entry) => !entry.builtIn).length);

  constructor() {
    effect(() => {
      const slug = this.store.activeProject();
      this.tasks.set([]);
      if (slug) void this.load();
    });
  }

  private async load(): Promise<void> {
    const slug = this.store.activeProject();
    const result = await this.api
      .get<{ tasks: AgentTask[] }>(`${this.api.projectPath(slug)}/agent-tasks`)
      .catch(() => null);
    if (result && slug === this.store.activeProject()) this.tasks.set(result.tasks);
  }

  protected toggle(): void {
    if (this.open()) return this.close();
    this.open.set(true);
    this.query.set('');
    this.active.set(0);
    this.editing.set(null);
    void this.load();
    setTimeout(() => this.search()?.nativeElement.focus());
  }

  protected close(): void {
    this.open.set(false);
    this.editing.set(null);
  }

  protected outside(event: MouseEvent): void {
    // composedPath statt contains: Knöpfe, die beim Klick aus dem DOM verschwinden, zählen nicht als „daneben“.
    if (this.open() && !event.composedPath().includes(this.host.nativeElement)) this.close();
  }

  protected setQuery(value: string): void {
    this.query.set(value);
    this.active.set(0);
  }

  protected keydown(event: KeyboardEvent): void {
    const count = this.entries().length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (count) this.active.set((this.active() + (event.key === 'ArrowDown' ? 1 : count - 1)) % count);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const entry = this.entries()[this.active()];
      if (entry) void this.run(entry);
    }
  }

  /** Startet die Aufgabe: eigene über die API (zählt mit), Vorlagen direkt als Nachricht an den Assistenten. */
  protected async run(entry: TaskEntry): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      if (entry.id) {
        await this.api.post(`/api/agent-tasks/${encodeURIComponent(entry.id)}/run`, {});
      } else {
        await this.api.post(`${this.api.projectPath(this.store.activeProject())}/chat`, {
          content: `Aufgabe „${entry.title}“:\n${entry.prompt}`,
          agentId: this.agentId(),
        });
      }
      const who = entry.id ? entry.agentName : this.agentName(this.agentId());
      this.store.notice.set(`Aufgabe „${entry.title}“ gestartet – ${who ?? 'der Assistent'} arbeitet sie ab.`);
      this.close();
    } catch (error) {
      this.store.notice.set(error instanceof Error ? error.message : 'Aufgabe konnte nicht gestartet werden.');
    } finally {
      this.busy.set(false);
    }
  }

  protected agentName(id: string | null): string | null {
    return id ? (this.agents().find((agent) => agent.id === id)?.name ?? null) : null;
  }

  protected startNew(): void {
    this.editing.set({ id: null, title: this.query().trim(), prompt: '', agentId: this.agentId() });
  }

  /** Vorlagen werden als neue eigene Aufgabe bearbeitet, eigene direkt. */
  protected edit(entry: TaskEntry, event: Event): void {
    event.stopPropagation();
    this.editing.set({
      id: entry.id,
      title: entry.title,
      prompt: entry.prompt,
      agentId: entry.id ? entry.agentId : this.agentId(),
    });
  }

  protected async save(title: string, prompt: string, agentId: string, andRun: boolean): Promise<void> {
    const form = this.editing();
    if (!form || this.busy()) return;
    this.busy.set(true);
    try {
      const body = { title: title.trim(), prompt: prompt.trim(), agentId: agentId || null };
      const saved = form.id
        ? await this.api.patch<AgentTask>(`/api/agent-tasks/${encodeURIComponent(form.id)}`, body)
        : await this.api.post<AgentTask>(`${this.api.projectPath(this.store.activeProject())}/agent-tasks`, body);
      await this.load();
      this.editing.set(null);
      this.busy.set(false);
      if (andRun) await this.run({ ...saved, builtIn: false });
      else this.store.notice.set(`Aufgabe „${saved.title}“ gespeichert.`);
    } catch (error) {
      this.store.notice.set(error instanceof Error ? error.message : 'Aufgabe konnte nicht gespeichert werden.');
    } finally {
      this.busy.set(false);
    }
  }

  protected async remove(entry: TaskEntry, event: Event): Promise<void> {
    event.stopPropagation();
    if (!entry.id || !globalThis.confirm(`Aufgabe „${entry.title}“ löschen?`)) return;
    await this.api.delete(`/api/agent-tasks/${encodeURIComponent(entry.id)}`).catch(() => undefined);
    await this.load();
  }
}
