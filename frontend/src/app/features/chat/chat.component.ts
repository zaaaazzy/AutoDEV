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

  /** false, solange die Live-Verbindung zum Verlauf unterbrochen ist (z. B. Server-Neustart, Ruhezustand). */
  protected readonly connected = signal(true);
  private reconnectNow: (() => void) | null = null;

  constructor() {
    effect((onCleanup) => {
      const slug = this.store.activeProject();
      if (!slug) return;
      let stream: EventSource | null = null;
      let retry: ReturnType<typeof setTimeout> | undefined;
      let attempt = 0;
      let stopped = false;
      const show = (messages: ChatMessage[]): void => {
        this.chat.set(messages);
        globalThis.setTimeout(() => {
          const log = document.querySelector('.chat-log');
          if (log) log.scrollTop = log.scrollHeight;
        });
      };
      const connect = (): void => {
        globalThis.clearTimeout(retry);
        stream?.close();
        stream = new EventSource(this.api.url(`${this.api.projectPath(slug)}/chat/stream`));
        stream.onopen = () => {
          attempt = 0;
          this.connected.set(true);
        };
        stream.onmessage = (event: MessageEvent<string>) => {
          this.connected.set(true);
          show(JSON.parse(event.data) as ChatMessage[]);
        };
        // Bei einer Fehlantwort (z. B. 502 vom Proxy während eines Neustarts) gibt der Browser die Verbindung
        // endgültig auf. Dann selbst neu verbinden und den Verlauf bis dahin einmal direkt laden.
        stream.onerror = () => {
          if (stream?.readyState !== EventSource.CLOSED || stopped) return;
          this.connected.set(false);
          void this.api
            .get<{ messages?: ChatMessage[] }>(`${this.api.projectPath(slug)}/chat`)
            .then((result) => !stopped && show(result.messages ?? []))
            .catch(() => undefined);
          retry = globalThis.setTimeout(connect, Math.min(30_000, 2_000 * 2 ** attempt++));
        };
      };
      // Nach Ruhezustand oder Funkloch nicht auf den nächsten Versuch warten.
      const wake = (): void => {
        if (!document.hidden && stream?.readyState === EventSource.CLOSED) connect();
      };
      this.reconnectNow = connect;
      connect();
      document.addEventListener('visibilitychange', wake);
      globalThis.addEventListener('online', wake);
      onCleanup(() => {
        stopped = true;
        globalThis.clearTimeout(retry);
        document.removeEventListener('visibilitychange', wake);
        globalThis.removeEventListener('online', wake);
        stream?.close();
        this.reconnectNow = null;
        this.connected.set(true);
        this.chat.set([]);
      });
    });
  }

  protected reconnect(): void {
    this.reconnectNow?.();
  }

  protected async send(message: ComposedMessage, composer: ChatComposerComponent): Promise<void> {
    if (!this.store.activeProject()) return;
    try {
      await this.api.post(`${this.api.projectPath(this.store.activeProject())}/chat`, {
        content: message.content,
        agentId: this.agentId() || null,
        references: message.references.map(({ type, id }) => ({ type, id })),
      });
      // Ohne Live-Verbindung käme die Antwort nie an: sofort neu verbinden.
      if (!this.connected()) this.reconnect();
    } catch (error) {
      composer.restore(message);
      this.store.notice.set(error instanceof Error ? error.message : 'Nachricht konnte nicht gesendet werden.');
    }
  }

  protected async clear(): Promise<void> {
    await this.api.delete(`${this.api.projectPath(this.store.activeProject())}/chat`);
  }
}
