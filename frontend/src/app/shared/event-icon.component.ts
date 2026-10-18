import { Component, input } from '@angular/core';

/** Symbol einer Agent-Aktion (Lesen, Suchen, Schreiben, Ausführen) – im Verlauf und in der Dateiübersicht. */
@Component({
  selector: 'app-event-icon',
  standalone: true,
  host: {
    '[class]': "'event-icon icon-' + icon()",
    role: 'img',
    '[attr.aria-label]': 'label()',
    '[title]': 'label()',
  },
  template: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      @switch (icon()) {
        @case ('read') {
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
        }
        @case ('search') {
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        }
        @case ('write') {
          <path d="M4 20h4L19 9l-4-4L4 16v4z" />
          <path d="m14 6 4 4" />
        }
        @default {
          <path d="m5 8 4 4-4 4M12 17h7" />
        }
      }
    </svg>
  `,
})
export class EventIconComponent {
  readonly icon = input<string | null>('run');
  readonly label = input('');
}
