import { Component, signal } from '@angular/core';
import { ChatComponent } from './chat.component.js';

/** Sprechblase unten rechts: öffnet den Assistenten-Chat in einem kleinen Fenster, per Zoom als Modal. */
@Component({
  selector: 'app-chat-bubble',
  standalone: true,
  imports: [ChatComponent],
  template: `
    @if (open()) {
      <div class="chat-bubble-window">
        <app-chat [bubble]="true" (closed)="open.set(false)" />
      </div>
    }
    <button
      type="button"
      class="chat-bubble"
      [class.open]="open()"
      (click)="open.set(!open())"
      [attr.aria-expanded]="open()"
      [title]="open() ? 'Chat schließen' : 'Assistent fragen'"
      [attr.aria-label]="open() ? 'Chat schließen' : 'Assistent fragen'"
    >
      @if (open()) {
        <span aria-hidden="true">✕</span>
      } @else {
        <svg
          viewBox="0 0 24 24"
          width="24"
          height="24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
        </svg>
      }
    </button>
  `,
})
export class ChatBubbleComponent {
  protected readonly open = signal(false);
}
