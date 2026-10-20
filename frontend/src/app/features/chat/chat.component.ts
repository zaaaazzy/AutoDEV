import { Component, ElementRef, computed, effect, inject, input, output, signal } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import { AuthService } from '../../core/auth.service.js';
import type { ChatMessage } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { NavIconComponent } from '../../shared/nav-icon.component.js';
import { StepResultComponent } from '../../shared/step-result.component.js';
import { AgentTasksComponent } from './agent-tasks.component.js';
import { ChatComposerComponent, type ComposedMessage } from './chat-composer.component.js';

/** Nachladen per GET, solange die Live-Verbindung (noch) nichts geliefert hat. */
const FALLBACK_POLL_MS = 3_000;
/** Ab dieser Fensterbreite dockt der vergrößerte Chat rechts an, darunter öffnet er als Modal. */
const DOCK_MIN_WIDTH = 1200;

/** Vergrößerte Darstellung: rechts angedockt (großer Bildschirm) oder als Modal. */
export type ChatZoom = 'docked' | 'modal' | null;

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [StepResultComponent, AgentTasksComponent, ChatComposerComponent, NavIconComponent],
  templateUrl: './chat.component.html',
  host: {
    style: 'display: contents',
    '(document:keydown.escape)': 'zoom.set(null)',
    '(window:resize)': 'fitZoom()',
  },
})
export class ChatComponent {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);
  protected readonly auth = inject(AuthService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Kompakte Variante in der Sprechblase unten rechts: Zoom öffnet dort immer das Modal. */
  readonly bubble = input(false);
  /** Schließen-Knopf der Sprechblase. */
  readonly closed = output<void>();
  protected readonly zoom = signal<ChatZoom>(null);

  protected readonly chat = signal<ChatMessage[]>([]);
  protected readonly chatWaiting = computed(() =>
    this.chat().some((message) => message.role === 'user' && ['pending', 'processing'].includes(message.status)),
  );
  /** Unbeantwortete Rückfragen – auch ältere, wenn inzwischen anderes im Chat stand. */
  protected readonly openQuestions = computed(() =>
    this.chat().filter((message) => message.role === 'assistant' && message.question && !message.answered),
  );
  /** Mit „Eigene Antwort …“ gewählte Rückfrage; sonst gilt die jüngste offene. */
  private readonly chosenReply = signal<string | null>(null);
  /** Mit ✕ verworfen: die nächste Nachricht ist eine neue Anfrage. */
  private readonly dismissedReply = signal<string | null>(null);
  protected readonly replyTarget = computed(() => {
    const open = this.openQuestions();
    const chosen = open.find((message) => message.id === this.chosenReply());
    if (chosen) return chosen;
    const latest = open.at(-1);
    return latest && latest.id !== this.dismissedReply() ? latest : null;
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
    // Angedockt: der Hauptbereich macht rechts Platz, damit nichts verdeckt wird.
    effect((onCleanup) => {
      if (this.zoom() !== 'docked') return;
      document.body.classList.add('chat-docked');
      onCleanup(() => document.body.classList.remove('chat-docked'));
    });
    effect((onCleanup) => {
      const slug = this.store.activeProject();
      if (!slug) return;
      let stream: EventSource | null = null;
      let retry: ReturnType<typeof setTimeout> | undefined;
      let attempt = 0;
      let stopped = false;
      let shown = '';
      const show = (messages: ChatMessage[]): void => {
        // Unveränderten Verlauf nicht neu setzen (sonst springt die Ansicht bei jedem Nachladen nach unten).
        const snapshot = JSON.stringify(messages);
        if (snapshot === shown) return;
        shown = snapshot;
        this.chat.set(messages);
        this.scrollToEnd();
      };
      // Der Verlauf wird sofort per GET geladen und nicht erst mit der ersten Nachricht der Live-Verbindung:
      // Hängt diese (Proxy puffert, Browser-Verbindungslimit, Seitenwechsel), bliebe der Chat sonst leer.
      // Solange die Live-Verbindung nichts liefert, wird zusätzlich regelmäßig nachgeladen.
      let streamDelivered = false;
      let poll: ReturnType<typeof setInterval> | undefined;
      const loadOnce = (): void => {
        void this.api
          .get<{ messages?: ChatMessage[] }>(`${this.api.projectPath(slug)}/chat`)
          .then((result) => !stopped && !streamDelivered && show(result.messages ?? []))
          .catch(() => undefined);
      };
      const connect = (): void => {
        globalThis.clearTimeout(retry);
        globalThis.clearInterval(poll);
        stream?.close();
        streamDelivered = false;
        loadOnce();
        poll = globalThis.setInterval(() => !streamDelivered && loadOnce(), FALLBACK_POLL_MS);
        stream = new EventSource(this.api.url(`${this.api.projectPath(slug)}/chat/stream`));
        stream.onopen = () => {
          attempt = 0;
          this.connected.set(true);
        };
        stream.onmessage = (event: MessageEvent<string>) => {
          streamDelivered = true;
          globalThis.clearInterval(poll);
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
        globalThis.clearInterval(poll);
        document.removeEventListener('visibilitychange', wake);
        globalThis.removeEventListener('online', wake);
        stream?.close();
        this.reconnectNow = null;
        this.connected.set(true);
        this.chat.set([]);
      });
    });
  }

  /** Zoom-Knopf: vergrößern bzw. zurück zur normalen Ansicht. */
  protected toggleZoom(): void {
    if (this.zoom()) {
      this.zoom.set(null);
    } else {
      this.zoom.set(this.bubble() || globalThis.innerWidth < DOCK_MIN_WIDTH ? 'modal' : 'docked');
    }
    this.scrollToEnd();
  }

  /** Wird das Fenster zu schmal zum Andocken, als Modal weiterzeigen. */
  protected fitZoom(): void {
    if (this.zoom() === 'docked' && globalThis.innerWidth < DOCK_MIN_WIDTH) this.zoom.set('modal');
  }

  private scrollToEnd(): void {
    globalThis.setTimeout(() => {
      // Mehrere Chats (Dashboard und Sprechblase) möglich: nur den eigenen Verlauf scrollen.
      const log = this.host.nativeElement.querySelector('.chat-log');
      if (log) log.scrollTop = log.scrollHeight;
    });
  }

  protected reconnect(): void {
    this.reconnectNow?.();
  }

  protected async send(message: ComposedMessage, composer: ChatComposerComponent): Promise<void> {
    if (!this.store.activeProject()) return;
    const reply = this.replyTarget();
    try {
      await this.post(message.content, reply?.id ?? null, message.references);
      this.chosenReply.set(null);
    } catch (error) {
      composer.restore(message);
      this.store.notice.set(error instanceof Error ? error.message : 'Nachricht konnte nicht gesendet werden.');
    }
  }

  /** Antwortmöglichkeit der Rückfrage anklicken: geht direkt als Antwort an den fragenden Agent. */
  protected async answerWith(question: ChatMessage, option: string): Promise<void> {
    try {
      await this.post(option, question.id, []);
      this.chosenReply.set(null);
    } catch (error) {
      this.store.notice.set(error instanceof Error ? error.message : 'Antwort konnte nicht gesendet werden.');
    }
  }

  /** „Eigene Antwort …“: Eingabefeld auf diese Rückfrage richten. */
  protected replyTo(question: ChatMessage): void {
    this.chosenReply.set(question.id);
    this.dismissedReply.set(null);
    globalThis.setTimeout(() =>
      this.host.nativeElement.querySelector<HTMLInputElement>('app-chat-composer input')?.focus(),
    );
  }

  /** ✕ am Antwort-Hinweis: nächste Nachricht ist eine neue Anfrage. */
  protected newRequest(): void {
    this.dismissedReply.set(this.replyTarget()?.id ?? null);
    this.chosenReply.set(null);
  }

  private async post(content: string, replyTo: string | null, references: ComposedMessage['references']) {
    await this.api.post(`${this.api.projectPath(this.store.activeProject())}/chat`, {
      content,
      // Antworten gehen an den Agent der Rückfrage; den bestimmt der Server.
      agentId: replyTo ? null : this.agentId() || null,
      replyTo,
      references: references.map(({ type, id }) => ({ type, id })),
    });
    // Ohne Live-Verbindung käme die Antwort nie an: sofort neu verbinden.
    if (!this.connected()) this.reconnect();
  }

  protected async clear(): Promise<void> {
    await this.api.delete(`${this.api.projectPath(this.store.activeProject())}/chat`);
  }
}
