import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import type { ChatMessage } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './chat.component.html',
  host: { style: 'display: contents' },
})
export class ChatComponent {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);

  protected readonly chat = signal<ChatMessage[]>([]);
  protected readonly chatWaiting = computed(() =>
    this.chat().some((message) => message.role === 'user' && ['pending', 'processing'].includes(message.status)),
  );
  protected readonly chatProgressShown = computed(() =>
    this.chat().some((message) => message.role === 'assistant' && message.status === 'processing'),
  );
  protected chatInput = '';

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

  protected async send(): Promise<void> {
    const content = this.chatInput.trim();
    if (!content || !this.store.activeProject()) return;
    this.chatInput = '';
    try {
      await this.api.post(`${this.api.projectPath(this.store.activeProject())}/chat`, { content });
    } catch (error) {
      this.chatInput = content;
      this.store.notice.set(error instanceof Error ? error.message : 'Nachricht konnte nicht gesendet werden.');
    }
  }

  protected async clear(): Promise<void> {
    await this.api.delete(`${this.api.projectPath(this.store.activeProject())}/chat`);
  }
}
