import { Component, DestroyRef, computed, inject, input } from '@angular/core';
import { AuthService } from '../../core/auth.service.js';
import type { DevelopmentItem } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { WaitStatusComponent } from '../runs/wait-status.component.js';
import { OrderService } from '../development/order.service.js';
import { ReviewStateService } from '../development/review-state.service.js';

/**
 * Abnahme auf der Seite „Aktionen“: Punkte, die nur ein Mensch prüfen kann, im Review-Container ausprobieren.
 * Der Container zeigt den Stand, in dem der Auftrag steckt (Sprint-Branch, sonst main) – mit eigener Datenbank-Kopie.
 */
@Component({
  selector: 'app-acceptance-review',
  standalone: true,
  imports: [WaitStatusComponent],
  template: `
    @if (state(); as review) {
      @if (!review.configured) {
        <p class="muted small">
          Zum Ausprobieren fehlt der Review-Befehl – unter Einstellungen → Review-Freigabe ergänzen.
        </p>
      } @else {
        @if (shown(); as slot) {
          <p class="approval-instance">
            <span class="approval-dot" [class]="slot.status"></span>
            {{ slot.status === 'running' && wait.status() ? 'Review ' + slot.slot : instanceLabel() }}
            @if (slot.status === 'running') {
              · <a [href]="slot.url" target="_blank" rel="noopener">Review {{ slot.slot }} öffnen ↗</a>
            }
          </p>
          <app-wait-status #wait />
          @if (slot.status === 'failed' && slot.message) {
            <pre class="approval-log">{{ slot.message }}</pre>
          }
        }
        @if (auth.can('run') && (!shown() || shown()?.status === 'failed')) {
          <button class="button secondary" type="button" [disabled]="busy()" (click)="start(order())">
            {{ shown() ? '↻ Review-Container neu starten' : '🖥 Im Review-Container prüfen' }}
          </button>
        }
      }
    }
  `,
})
export class AcceptanceReviewComponent {
  private readonly store = inject(ProjectStore);
  private readonly orders = inject(OrderService);
  private readonly review = inject(ReviewStateService);
  protected readonly auth = inject(AuthService);
  protected readonly busy = this.store.busy;

  readonly order = input.required<DevelopmentItem>();
  protected readonly state = this.review.state;
  /** Review-Container, der diesen Auftrag zeigt (bzw. für ihn angefordert ist). */
  protected readonly shown = computed(
    () => this.state()?.slots.find((slot) => slot.developmentId === this.order().id && slot.status !== 'idle') ?? null,
  );
  protected readonly instanceLabel = computed(() => {
    const slot = this.shown();
    switch (slot?.status) {
      case 'running':
        return `Review ${slot.slot} läuft`;
      case 'starting':
        return `Review ${slot.slot} startet (Abhängigkeiten, Datenbank-Kopie) …`;
      case 'failed':
        return `Review ${slot.slot} konnte nicht starten`;
      default:
        return 'Wird gestartet …';
    }
  });

  constructor() {
    // Ein gemeinsamer Poll für alle Boxen (Freigabe und Abnahme), nur solange eine angezeigt wird.
    inject(DestroyRef).onDestroy(this.review.subscribe());
  }

  protected async start(item: DevelopmentItem): Promise<void> {
    const slug = this.store.activeProject();
    await this.orders.showReview(item);
    if (this.store.isActive(slug)) await this.review.refresh();
  }
}
