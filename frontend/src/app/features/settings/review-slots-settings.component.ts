import { Component, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import { errorMessage } from '../../core/errors.js';
import type { ReviewSlot } from '../../core/models.js';
import { SettingsGroupDirective } from './settings-group.js';

const STATUS_TEXT: Record<ReviewSlot['status'], string> = {
  idle: 'frei',
  requested: 'angefordert',
  starting: 'startet',
  running: 'läuft',
  failed: 'Fehler',
  stopping: 'wird beendet',
};

/** Administration: Review-Container freigeben (projektübergreifend geteilt, einer ist Standard). */
@Component({
  selector: 'app-review-slots-settings',
  standalone: true,
  imports: [SettingsGroupDirective],
  template: `
    <details appSettingsGroup="review-container">
      <summary class="section-heading">
        <div>
          <h2>Review-Container</h2>
          <p class="muted">
            Geteilt von allen Projekten. Jeder freigegebene Container startet einen gewählten Stand (Sprint-Ansicht)
            oder einen Auftrag, der auf die Freigabe wartet – mit eigener Datenbank-Kopie, nur auf diesem Rechner
            erreichbar.
          </p>
        </div>
      </summary>
      @if (error()) {
        <p class="notice error" role="alert">{{ error() }}</p>
      }
      <ul class="review-slot-list plain-list">
        @for (slot of slots(); track slot.slot) {
          <li>
            <label class="check">
              <input type="checkbox" [checked]="slot.enabled" (change)="toggle(slot, $any($event.target))" />
              <span
                >Review {{ slot.slot }} · <code>{{ slot.url }}</code></span
              >
            </label>
            <span class="muted">
              {{ statusText(slot) }}
              @if (slot.projectSlug) {
                · {{ slot.projectSlug }}: {{ slot.label }}
              }
            </span>
            @if (slot.status !== 'idle' && slot.status !== 'stopping') {
              <button class="link-button" type="button" (click)="stop(slot)">beenden</button>
            }
          </li>
        }
      </ul>
    </details>
  `,
})
export class ReviewSlotsSettingsComponent {
  private readonly api = inject(ApiService);
  protected readonly slots = signal<ReviewSlot[]>([]);
  protected readonly error = signal('');

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.slots.set((await this.api.get<{ slots: ReviewSlot[] }>('/api/review-slots')).slots);
      this.error.set('');
    } catch (error) {
      this.error.set(errorMessage(error, 'Review-Container konnten nicht geladen werden.'));
    }
  }

  protected statusText(slot: ReviewSlot): string {
    return slot.enabled ? STATUS_TEXT[slot.status] : 'gesperrt';
  }

  protected async toggle(slot: ReviewSlot, input: HTMLInputElement): Promise<void> {
    try {
      this.slots.set(
        (await this.api.put<{ slots: ReviewSlot[] }>(`/api/review-slots/${slot.slot}`, { enabled: input.checked }))
          .slots,
      );
      this.error.set('');
    } catch (error) {
      this.error.set(errorMessage(error, 'Freigabe konnte nicht gespeichert werden.'));
      // Die Checkbox ist im DOM schon umgeschaltet; [checked] ändert sich nicht und setzt sie nicht zurück.
      input.checked = slot.enabled;
    }
  }

  protected async stop(slot: ReviewSlot): Promise<void> {
    await this.api.post(`/api/review-slots/${slot.slot}/stop`).catch(() => undefined);
    await this.load();
  }
}
