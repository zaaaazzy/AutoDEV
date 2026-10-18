import { Component, computed, ElementRef, inject, input, signal, viewChild } from '@angular/core';
import { type ActionForm, type AgentAction, AgentActionsService } from '../../core/agent-actions.service.js';
import { AuthService } from '../../core/auth.service.js';
import { ProjectStore } from '../../core/project-store.js';

const normalize = (value: string) => value.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');

/** Gespeicherte Agent-Aufgaben: per Dropdown suchen und mit einem Klick an den Assistenten übergeben. */
@Component({
  selector: 'app-agent-tasks',
  standalone: true,
  templateUrl: './agent-tasks.component.html',
  host: { class: 'agent-tasks', '(document:click)': 'outside($event)', '(keydown.escape)': 'close()' },
})
export class AgentTasksComponent {
  private readonly store = inject(ProjectStore);
  private readonly host = inject(ElementRef<HTMLElement>);
  protected readonly actions = inject(AgentActionsService);
  protected readonly auth = inject(AuthService);
  protected readonly open = signal(false);
  protected readonly query = signal('');
  protected readonly active = signal(0);
  protected readonly busy = this.actions.busy;
  /** Formular: null = geschlossen, id null = neue Aktion. */
  protected readonly editing = signal<ActionForm | null>(null);
  /** Im Chat gewählter Agent: Vorgabe für neue Aktionen. */
  readonly agentId = input<string | null>(null);
  /** Agents des Projekts, denen eine Aktion gehören kann. */
  protected readonly agents = computed(() => this.store.data().agents.filter((agent) => agent.enabled));
  private readonly search = viewChild<ElementRef<HTMLInputElement>>('search');

  protected readonly entries = computed<AgentAction[]>(() => {
    const terms = normalize(this.query()).split(/\s+/).filter(Boolean);
    return this.actions.actions().filter((action) => {
      const text = normalize(`${action.title} ${action.prompt} ${action.agentName ?? ''}`);
      return terms.every((term) => text.includes(term));
    });
  });

  protected toggle(): void {
    if (this.open()) return this.close();
    this.open.set(true);
    this.query.set('');
    this.active.set(0);
    this.editing.set(null);
    void this.actions.load();
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

  protected async run(action: AgentAction): Promise<void> {
    if (await this.actions.run(action)) this.close();
  }

  protected startNew(): void {
    this.editing.set({ id: null, title: this.query().trim(), prompt: '', agentId: this.agentId() });
  }

  protected edit(action: AgentAction, event: Event): void {
    event.stopPropagation();
    this.editing.set({ id: action.id, title: action.title, prompt: action.prompt, agentId: action.agentId });
  }

  protected async save(title: string, prompt: string, agentId: string, andRun: boolean): Promise<void> {
    const form = this.editing();
    if (!form) return;
    const saved = await this.actions.save({ ...form, title, prompt, agentId: agentId || null });
    if (!saved) return;
    this.editing.set(null);
    if (andRun) await this.run(saved);
    else this.store.notice.set(`Aktion „${saved.title}“ gespeichert.`);
  }

  protected async remove(action: AgentAction, event: Event): Promise<void> {
    event.stopPropagation();
    await this.actions.remove(action);
  }
}
