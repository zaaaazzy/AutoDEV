import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { type RestartState, RestartStatusService } from '../core/restart-status.service.js';
import { visibleInterval } from '../core/visible-interval.js';
import { formatElapsed, pullNote } from './restart-text.js';

const STEPS: { status: RestartState['status']; label: string }[] = [
  { status: 'requested', label: 'Angefordert' },
  { status: 'building', label: 'Neuester Stand & Neubau' },
  { status: 'restarting', label: 'Worker startet neu' },
  { status: 'done', label: 'Fertig' },
];

/** Wie lange ein abgeschlossener Neustart noch oben sichtbar bleibt. */
const SHOW_FINISHED_MS = 15 * 60_000;
const DISMISSED_KEY = 'aideation:restart-dismissed';

function readDismissed(): string {
  try {
    return globalThis.localStorage?.getItem(DISMISSED_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * Statusleiste oben in der App, solange AIdeation neu startet: Schritte, Laufzeit, aktuelle Meldung. Danach noch eine
 * Weile Erfolg (mit „Seite neu laden“ für die neue Oberfläche) oder Fehler samt Log. Nur für die Administration.
 */
@Component({
  selector: 'app-restart-banner',
  standalone: true,
  template: `
    @if (visible(); as restart) {
      <section
        class="restart-banner"
        [class.done]="restart.status === 'done'"
        [class.failed]="restart.status === 'failed'"
        role="status"
        aria-live="polite"
        aria-label="Neustart von AIdeation"
      >
        <div class="restart-head">
          <strong>
            @switch (restart.status) {
              @case ('done') {
                ✓ AIdeation läuft mit dem neuen Stand
              }
              @case ('failed') {
                ✕ Neustart fehlgeschlagen
              }
              @default {
                <span class="live-dot"></span> AIdeation startet neu
              }
            }
          </strong>
          <span class="muted">
            {{ restart.requestedBy ? 'von ' + restart.requestedBy + ' · ' : '' }}{{ elapsed() }}
          </span>
        </div>
        <ol class="restart-steps">
          @for (step of steps; track step.status) {
            <li [class]="stepState(step.status)">{{ step.label }}</li>
          }
        </ol>
        @if (status.unreachable() && status.open()) {
          <p>AIdeation ist gerade kurz nicht erreichbar – die Container werden getauscht. Das ist normal.</p>
        } @else if (restart.message) {
          <p>{{ restart.message }}</p>
        }
        @if (note()) {
          <p class="muted">{{ note() }}</p>
        }
        @if (restart.status === 'failed' && restart.log) {
          <details>
            <summary>Ausgabe anzeigen</summary>
            <pre>{{ restart.log }}</pre>
          </details>
        }
        @if (!status.open()) {
          <div class="restart-actions">
            @if (restart.status === 'done') {
              <button type="button" class="button primary" (click)="reload()">Seite neu laden</button>
            }
            <button type="button" class="button secondary" (click)="dismiss(restart)">Ausblenden</button>
          </div>
        }
      </section>
    }
  `,
})
export class RestartBannerComponent {
  protected readonly status = inject(RestartStatusService);
  protected readonly steps = STEPS;
  private readonly now = signal(Date.now());
  private readonly dismissed = signal(readDismissed());

  constructor() {
    void this.status.load();
    // Sekundentakt nur für die Laufzeitanzeige.
    inject(DestroyRef).onDestroy(visibleInterval(() => this.now.set(Date.now()), 1_000));
  }

  protected readonly visible = computed(() => {
    const restart = this.status.state();
    if (!restart) return null;
    if (this.status.open()) return restart;
    const finished = restart.finishedAt ? Date.parse(restart.finishedAt) : NaN;
    if (!Number.isFinite(finished) || this.now() - finished > SHOW_FINISHED_MS) return null;
    return this.dismissed() === restart.finishedAt ? null : restart;
  });

  protected readonly elapsed = computed(() => {
    const restart = this.visible();
    if (!restart) return '';
    const start = Date.parse(restart.requestedAt);
    const end = restart.finishedAt ? Date.parse(restart.finishedAt) : this.now();
    return `${this.status.open() ? 'läuft seit' : 'Dauer'} ${formatElapsed(end - start)}`;
  });

  protected readonly note = computed(() => pullNote(this.visible()?.log));

  protected stepState(step: RestartState['status']): string {
    const current = this.visible()?.status;
    if (!current) return '';
    const order = STEPS.map((entry) => entry.status);
    // Fehlgeschlagen: der Schritt, in dem es scheiterte, ist rot (ohne Bau: „Angefordert“).
    if (current === 'failed') {
      const failedAt = this.visible()?.startedAt ? 'building' : 'requested';
      const index = order.indexOf(failedAt);
      return order.indexOf(step) < index ? 'passed' : step === failedAt ? 'failed' : '';
    }
    const index = order.indexOf(current);
    const position = order.indexOf(step);
    return position < index || current === 'done' ? 'passed' : position === index ? 'active' : '';
  }

  protected dismiss(restart: RestartState): void {
    const value = restart.finishedAt ?? '';
    this.dismissed.set(value);
    try {
      globalThis.localStorage?.setItem(DISMISSED_KEY, value);
    } catch {
      // Ohne Speicher bleibt das Ausblenden nur bis zum Neuladen.
    }
  }

  protected reload(): void {
    globalThis.location.reload();
  }
}
