import {
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  model,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import { ProjectStore } from '../../core/project-store.js';
import { statusLabel } from '../../shared/labels.js';
import { NavIconComponent } from '../../shared/nav-icon.component.js';
import type { GitGraph } from '../dashboard/git-graph.js';
import {
  applySuggestion,
  type ChatReference,
  findTrigger,
  MENTION_CATEGORIES,
  type MentionItem,
  type MentionSource,
  PERSON_ICON,
  type Suggestion,
  suggestions,
  type Trigger,
} from './chat-mentions.js';

export interface ComposedMessage {
  content: string;
  references: ChatReference[];
}

const MAX_REFERENCES = 5;

/**
 * Chat-Eingabe: „@“ wählt den Agent oder spricht eine Person im Projekt an, „/“ verweist auf Auftrag, Idee, Bug,
 * Sprint, Doku oder Git. Vorschläge erscheinen als Bubbles und werden beim Tippen eingeschränkt; Auswahl wird zum Chip über dem Eingabefeld.
 */
@Component({
  selector: 'app-chat-composer',
  standalone: true,
  imports: [NavIconComponent],
  templateUrl: './chat-composer.component.html',
})
export class ChatComposerComponent {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);
  private readonly input = viewChild.required<ElementRef<HTMLInputElement>>('field');

  readonly placeholder = input('Nachricht …');
  /** Gewählter Agent ('' = allgemeiner Assistent); mit dem Chat geteilt (Aufgaben nutzen ihn auch). */
  readonly agentId = model('');
  readonly sent = output<ComposedMessage>();

  protected readonly text = signal('');
  protected readonly caret = signal(0);
  protected readonly references = signal<ChatReference[]>([]);
  protected readonly active = signal(0);
  /** Mit Escape geschlossen – bis sich der Text ändert. */
  private readonly dismissed = signal(false);
  private readonly commits = signal<GitGraph['commits']>([]);
  /** Personen im Projekt (wie bei den Erwähnungen in Kommentaren). */
  private readonly people = signal<MentionItem[]>([]);

  protected readonly agents = computed(() => this.store.data().agents.filter((agent) => agent.enabled));
  protected readonly agentName = computed(
    () => this.agents().find((agent) => agent.id === this.agentId())?.name ?? null,
  );

  private readonly source = computed<MentionSource>(() => {
    const data = this.store.data();
    return {
      agents: this.agents().map((agent) => ({ id: agent.id, label: agent.name })),
      people: this.people(),
      items: {
        order: data.development.map((item) => ({ id: item.id, label: item.title, hint: statusLabel(item.status) })),
        idea: data.ideas.map((idea) => ({ id: idea.id, label: idea.title, hint: statusLabel(idea.status) })),
        bug: data.bugs.map((bug) => ({ id: bug.id, label: bug.title, hint: statusLabel(bug.status) })),
        sprint: data.sprints.map((sprint) => ({ id: sprint.id, label: sprint.name, hint: statusLabel(sprint.status) })),
        doc: data.docs.map((doc) => ({ id: doc.id, label: doc.title })),
        commit: this.commits().map((commit) => ({
          id: commit.hash,
          label: commit.subject,
          hint: commit.hash.slice(0, 7),
        })),
      },
    };
  });

  protected readonly trigger = computed<Trigger | null>(() =>
    this.dismissed() ? null : findTrigger(this.text(), this.caret()),
  );
  protected readonly options = computed<Suggestion[]>(() => {
    const trigger = this.trigger();
    return trigger ? suggestions(trigger, this.source()) : [];
  });
  protected readonly title = computed(() => {
    const trigger = this.trigger();
    if (!trigger) return '';
    if (trigger.kind === 'agent') return 'Agent oder Person ansprechen';
    if (trigger.kind === 'category') return 'Worauf beziehst du dich?';
    return `${trigger.category.label} wählen`;
  });

  constructor() {
    effect(() => {
      const slug = this.store.activeProject();
      if (!slug) return;
      this.api
        .get<{ people?: { id: string; name: string }[] }>(`${this.api.projectPath(slug)}/people`)
        .then((result) => this.people.set((result.people ?? []).map(({ id, name }) => ({ id, label: name }))))
        .catch(() => this.people.set([]));
    });
  }

  protected onInput(event: Event): void {
    const field = event.target as HTMLInputElement;
    this.text.set(field.value);
    this.caret.set(field.selectionStart ?? field.value.length);
    this.dismissed.set(false);
    this.active.set(0);
    const trigger = this.trigger();
    if (trigger?.kind === 'item' && trigger.category.type === 'commit' && !this.commits().length)
      void this.loadCommits();
  }

  protected onCaret(): void {
    const field = this.input().nativeElement;
    this.caret.set(field.selectionStart ?? field.value.length);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const count = this.options().length;
    if (!count) return;
    if (['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(event.key)) {
      // Pfeiltasten wechseln die Bubble nur, solange die Auswahl offen ist.
      event.preventDefault();
      const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : count - 1;
      this.active.set((this.active() + step) % count);
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      this.choose(this.options()[this.active()]!);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.dismissed.set(true);
    }
  }

  protected choose(suggestion: Suggestion): void {
    const trigger = this.trigger();
    if (!trigger) return;
    const applied = applySuggestion(this.text(), trigger, suggestion);
    if (applied.agentId) this.agentId.set(applied.agentId);
    if (applied.reference) {
      const reference = applied.reference;
      this.references.update((list) =>
        list.some((entry) => entry.type === reference.type && entry.id === reference.id) ||
        list.length >= MAX_REFERENCES
          ? list
          : [...list, reference],
      );
    }
    this.text.set(applied.text);
    this.caret.set(applied.caret);
    this.active.set(0);
    if (suggestion.kind === 'category' && suggestion.id === 'commit') void this.loadCommits();
    const field = this.input().nativeElement;
    field.value = applied.text;
    field.focus();
    field.setSelectionRange(applied.caret, applied.caret);
  }

  protected removeReference(reference: ChatReference): void {
    this.references.update((list) => list.filter((entry) => entry !== reference));
  }

  protected icon(reference: ChatReference): string {
    if (reference.type === 'user') return PERSON_ICON;
    return MENTION_CATEGORIES.find((category) => category.type === reference.type)?.icon ?? '/';
  }

  protected submit(): void {
    const content = this.text().trim();
    if (!content || this.options().length) return;
    this.sent.emit({ content, references: this.references() });
    this.text.set('');
    this.caret.set(0);
    this.references.set([]);
    this.input().nativeElement.value = '';
  }

  /** Stellt Text und Verweise wieder her, wenn das Senden scheitert. */
  restore(message: ComposedMessage): void {
    this.text.set(message.content);
    this.references.set(message.references);
    this.input().nativeElement.value = message.content;
  }

  private async loadCommits(): Promise<void> {
    const result = await this.api
      .get<{ graph: GitGraph | null }>(`${this.api.projectPath(this.store.activeProject())}/git-graph`)
      .catch(() => null);
    this.commits.set(result?.graph?.commits ?? []);
  }
}
