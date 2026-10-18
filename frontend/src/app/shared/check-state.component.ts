import { Component, input } from '@angular/core';

export type CheckState = 'idle' | 'loading' | 'ok' | 'error' | 'warn';

/** Prüfstatus: drehende Pfeile während der Prüfung, grüner Haken bei Erfolg (wie beim Sprint-Status), sonst Kreuz. */
@Component({
  selector: 'app-check-state',
  standalone: true,
  template: `
    @switch (state()) {
      @case ('loading') {
        <span class="check-state loading" role="status" aria-label="Wird geprüft">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path
              d="M20 12a8 8 0 0 1-13.7 5.6M4 12a8 8 0 0 1 13.7-5.6M17.7 2.5v4h-4M6.3 21.5v-4h4"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>
      }
      @case ('ok') {
        <span class="check-state ok" role="img" aria-label="In Ordnung">✓</span>
      }
      @case ('warn') {
        <span class="check-state warn" role="img" aria-label="Achtung">!</span>
      }
      @case ('error') {
        <span class="check-state error" role="img" aria-label="Fehler">✕</span>
      }
    }
  `,
  host: { style: 'display: inline-flex' },
})
export class CheckStateComponent {
  readonly state = input<CheckState>('idle');
}
