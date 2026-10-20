import { Component, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import type { ReviewSlot } from '../../core/models.js';

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
  template: `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Review-Container</h2>
          <p class="muted">
            Geteilt von allen Projekten. Jeder freigegebene Container startet einen gewählten Stand (Sprint-Ansicht)
            oder einen Auftrag, der auf die Freigabe wartet – mit eigener Datenbank-Kopie, nur auf diesem Rechner
            erreichbar.
          </p>
        </div>
      </div>
      <ul class="review-slot-list">
        @for (slot of slots(); track slot.slot) {
          <li>
            <label class="check">
              <input type="checkbox" [checked]="slot.enabled" (change)="toggle(slot, $any($event.target).checked)" />
              Review {{ slot.slot }} · <code>{{ slot.url }}</code>
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
    </section>
  `,
})
export class ReviewSlotsSettingsComponent {
  private readonly api = inject(ApiService);
  protected readonly slots = signal<ReviewSlot[]>([]);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    this.slots.set((await this.api.get<{ slots: ReviewSlot[] }>('/api/review-slots')).slots);
  }

  protected statusText(slot: ReviewSlot): string {
    return slot.enabled ? STATUS_TEXT[slot.status] : 'gesperrt';
  }

  protected async toggle(slot: ReviewSlot, enabled: boolean): Promise<void> {
    this.slots.set((await this.api.put<{ slots: ReviewSlot[] }>(`/api/review-slots/${slot.slot}`, { enabled })).slots);
  }

  protected async stop(slot: ReviewSlot): Promise<void> {
    await this.api.post(`/api/review-slots/${slot.slot}/stop`).catch(() => undefined);
    await this.load();
  }
}
