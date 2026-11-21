import { Component, inject } from '@angular/core';
import { THEME_LABELS, THEME_PREFERENCES } from '../core/theme.js';
import { ThemeService } from '../core/theme.service.js';

/** Umschalter Hell / Dunkel / System; die Wahl bleibt im Browser gespeichert. */
@Component({
  selector: 'app-theme-switch',
  standalone: true,
  host: { style: 'display: contents' },
  template: `
    <div class="theme-switch" role="group" aria-label="Farbschema">
      @for (option of options; track option) {
        <button
          type="button"
          class="theme-option"
          [class.active]="theme.preference() === option"
          [attr.aria-pressed]="theme.preference() === option"
          [attr.aria-label]="'Farbschema: ' + labels[option]"
          [title]="'Farbschema: ' + labels[option]"
          (click)="theme.set(option)"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor">
            @switch (option) {
              @case ('light') {
                <circle cx="12" cy="12" r="4" stroke-width="2" />
                <path
                  d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"
                  stroke-width="2"
                  stroke-linecap="round"
                />
              }
              @case ('dark') {
                <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" stroke-width="2" stroke-linejoin="round" />
              }
              @default {
                <rect x="3" y="4" width="18" height="12" rx="2" stroke-width="2" />
                <path d="M8 20h8M12 16v4" stroke-width="2" stroke-linecap="round" />
              }
            }
          </svg>
          <span class="theme-option-label">{{ labels[option] }}</span>
        </button>
      }
    </div>
  `,
})
export class ThemeSwitchComponent {
  protected readonly theme = inject(ThemeService);
  protected readonly options = THEME_PREFERENCES;
  protected readonly labels = THEME_LABELS;
}
