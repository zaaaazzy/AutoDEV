import { Component, computed, effect, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import { AuthService } from '../../core/auth.service.js';
import type { ChatMessage } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { NavIconComponent } from '../../shared/nav-icon.component.js';
import { StepResultComponent } from '../../shared/step-result.component.js';
import { AgentTasksComponent } from './agent-tasks.component.js';
import { ChatComposerComponent, type ComposedMessage } from './chat-composer.component.js';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [StepResultComponent, AgentTasksComponent, ChatComposerComponent, NavIconComponent],
  templateUrl: './chat.component.html',
  host: { style: 'display: contents' },
})
export class ChatComponent {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);
  protected readonly auth = inject(AuthService);

  protected readonly chat = signal<ChatMessage[]>([]);
  protected readonly chatWaiting = computed(() =>
    this.chat().some((message) => message.role === 'user' && ['pending', 'processing'].includes(message.status)),
  );
  /** Letzte Nachricht ist eine unbeantwortete Rückfrage des Assistenten. */
  protected readonly openQuestionId = computed(() => {
    const last = this.chat().at(-1);
    return last?.role === 'assistant' && last.question ? last.id : null;
  });
  protected readonly chatProgressShown = computed(() =>
    this.chat().some((message) => message.role === 'assistant' && message.status === 'processing'),
  );
  /** Wer die nächste Anfrage übernimmt ('' = allgemeiner Assistent); per „/“ in der Eingabe gewählt. */
  protected readonly agentId = signal('');

  constructor() {
    effect((onCleanup) => {
      const slug = this.store.activeProject();
      if (!slug) return;
      const stream = new EventSource(this.api.url(`${this.api.projectPath(slug)}/chat/stream`));
      stream.onmessage = (event: MessageEvent<string>) => {
        this.chat.set(JSON.parse(event.data) as ChatMessage[]);
        globalThis.setTimeout(() => {
          const log = document.querySelector('.chat-log');
          if (log) log.scrollTop = log.scrollHeight;
        });
      };
      onCleanup(() => {
        stream.close();
        this.chat.set([]);
      });
    });
  }

  protected async send(message: ComposedMessage, composer: ChatComposerComponent): Promise<void> {
    if (!this.store.activeProject()) return;
    try {
      await this.api.post(`${this.api.projectPath(this.store.activeProject())}/chat`, {
        content: message.content,
        agentId: this.agentId() || null,
        references: message.references.map(({ type, id }) => ({ type, id })),
      });
    } catch (error) {
      composer.restore(message);
      this.store.notice.set(error instanceof Error ? error.message : 'Nachricht konnte nicht gesendet werden.');
    }
  }

  protected async clear(): Promise<void> {
    await this.api.delete(`${this.api.projectPath(this.store.activeProject())}/chat`);
  }
}
