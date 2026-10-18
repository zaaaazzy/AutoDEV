import { DatePipe } from '@angular/common';
import { Component, computed, DestroyRef, effect, ElementRef, inject, input, signal, viewChild } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import { AuthService } from '../../core/auth.service.js';
import type { IdeaComment } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { MarkdownPipe } from '../../shared/markdown.pipe.js';
import {
  activeMentions,
  type AtTrigger,
  type CommentMention,
  findAtTrigger,
  highlightMentions,
  initials,
  insertMention,
  rankMentions,
} from './comment-mentions.js';

const POLL_MS = 4000;

/**
 * Kommentare einer Idee als Gesprächsverlauf: eigene Beiträge rechts, Agents mit eigener Farbe. „@“ spricht einen
 * Agent (er antwortet hier als Kommentar) oder eine Person an (sie bekommt eine Push-Meldung).
 */
@Component({
  selector: 'app-comment-thread',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './comment-thread.component.html',
})
export class CommentThreadComponent {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly store = inject(ProjectStore);
  private readonly markdown = new MarkdownPipe();
  private readonly field = viewChild.required<ElementRef<HTMLTextAreaElement>>('field');

  readonly ideationId = input.required<string>();
  protected readonly busy = this.store.busy;
  protected readonly text = signal('');
  protected readonly caret = signal(0);
  protected readonly chosen = signal<CommentMention[]>([]);
  protected readonly active = signal(0);
  private readonly people = signal<CommentMention[]>([]);
  private readonly dismissed = signal(false);

  protected readonly comments = computed(() =>
    this.store.data().comments.filter((comment) => comment.ideationId === this.ideationId()),
  );
  protected readonly working = computed(() =>
    this.comments().some((comment) => comment.agentStatus === 'pending' || comment.agentStatus === 'processing'),
  );
  private readonly candidates = computed<CommentMention[]>(() => [
    ...this.store
      .data()
      .agents.filter((agent) => agent.enabled)
      .map((agent) => ({ type: 'agent' as const, id: agent.id, name: agent.name })),
    ...this.people(),
  ]);
  protected readonly trigger = computed<AtTrigger | null>(() =>
    this.dismissed() ? null : findAtTrigger(this.text(), this.caret()),
  );
  protected readonly options = computed(() => {
    const trigger = this.trigger();
    return trigger ? rankMentions(this.candidates(), trigger.query) : [];
  });

  constructor() {
    effect(() => {
      const slug = this.store.activeProject();
      if (!slug) return;
      this.api
        .get<{ people?: { id: string; name: string }[] }>(`${this.api.projectPath(slug)}/people`)
        .then((result) => this.people.set((result.people ?? []).map((person) => ({ type: 'user', ...person }))))
        .catch(() => this.people.set([]));
    });
    // Solange ein Agent an einer Antwort arbeitet, die Kommentare regelmäßig nachladen.
    const timer = globalThis.setInterval(() => {
      if (this.working()) void this.reloadComments();
    }, POLL_MS);
    inject(DestroyRef).onDestroy(() => globalThis.clearInterval(timer));
  }

  protected isOwn(comment: IdeaComment): boolean {
    const user = this.auth.user();
    return comment.authorKind !== 'agent' && !!user && comment.author === (user.displayName || user.username);
  }

  protected isAgent(comment: IdeaComment): boolean {
    return comment.authorKind === 'agent' || this.store.data().agents.some((agent) => agent.name === comment.author);
  }

  protected initials(name: string): string {
    return initials(name);
  }

  protected body(comment: IdeaComment): string {
    return highlightMentions(this.markdown.transform(comment.body), comment.mentions ?? []);
  }

  protected replyAuthor(comment: IdeaComment): string | null {
    return comment.replyTo ? (this.comments().find((other) => other.id === comment.replyTo)?.author ?? null) : null;
  }

  protected onInput(event: Event): void {
    const field = event.target as HTMLTextAreaElement;
    this.text.set(field.value);
    this.caret.set(field.selectionStart ?? field.value.length);
    this.dismissed.set(false);
    this.active.set(0);
  }

  protected onCaret(): void {
    const field = this.field().nativeElement;
    this.caret.set(field.selectionStart ?? field.value.length);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const options = this.options();
    if (options.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        this.active.set((this.active() + step + options.length) % options.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        this.choose(options[this.active()]!);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.dismissed.set(true);
        return;
      }
    }
    // Enter sendet, Shift+Enter macht eine neue Zeile.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void this.submit();
    }
  }

  protected choose(option: CommentMention): void {
    const trigger = this.trigger();
    if (!trigger) return;
    const next = insertMention(this.text(), trigger, option.name);
    this.text.set(next.text);
    this.chosen.update((list) => [...list, option]);
    const field = this.field().nativeElement;
    field.value = next.text;
    field.focus();
    field.setSelectionRange(next.caret, next.caret);
    this.caret.set(next.caret);
  }

  protected startMention(): void {
    const field = this.field().nativeElement;
    const value = this.text();
    const prefix = value && !/\s$/.test(value) ? ' @' : '@';
    this.text.set(value + prefix);
    field.value = value + prefix;
    field.focus();
    this.caret.set(field.value.length);
    this.dismissed.set(false);
  }

  protected async submit(): Promise<void> {
    const body = this.text().trim();
    if (!body || this.busy()) return;
    const mentions = activeMentions(body, this.chosen()).map(({ type, id }) => ({ type, id }));
    const agents = mentions.filter((mention) => mention.type === 'agent').length;
    await this.store.perform(
      () => this.api.post(`/api/ideation/${encodeURIComponent(this.ideationId())}/comments`, { body, mentions }),
      agents ? 'Kommentar gespeichert – der Agent antwortet hier.' : 'Kommentar gespeichert.',
    );
    if (this.store.notice().startsWith('Kommentar')) {
      this.text.set('');
      this.chosen.set([]);
      this.field().nativeElement.value = '';
    }
  }

  private async reloadComments(): Promise<void> {
    const slug = this.store.activeProject();
    if (!slug) return;
    try {
      const board = await this.api.get<{ comments?: IdeaComment[] }>(`${this.api.projectPath(slug)}/board`);
      if (slug === this.store.activeProject())
        this.store.data.update((data) => ({ ...data, comments: board.comments ?? data.comments }));
    } catch {
      /* nächster Versuch beim nächsten Takt */
    }
  }
}
