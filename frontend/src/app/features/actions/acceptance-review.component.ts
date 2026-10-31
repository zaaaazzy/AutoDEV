import { Component, DestroyRef, computed, inject, input } from '@angular/core';
import { AuthService } from '../../core/auth.service.js';
import type { DevelopmentItem } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { orderReviewSlot, reviewLaunchable } from '../development/review-box.js';
import { ReviewSlotStatusComponent } from '../development/review-slot-status.component.js';
import { ReviewStateService } from '../development/review-state.service.js';

/**
 * Abnahme auf der Seite „Aktionen“: Punkte, die nur ein Mensch prüfen kann, im Review-Container ausprobieren.
 * Der Container zeigt den Stand, in dem der Auftrag steckt (Sprint-Branch, sonst main) – mit eigener Datenbank-Kopie.
 */
@Component({
  selector: 'app-acceptance-review',
  standalone: true,
  imports: [ReviewSlotStatusComponent],
  template: `
    @if (state(); as review) {
      @if (!review.configured) {
        <p class="muted small">
          Zum Ausprobieren fehlt der Review-Befehl – unter Einstellungen → Review-Freigabe ergänzen.
        </p>
      } @else {
        @if (shown(); as slot) {
          <app-review-slot-status [slot]="slot" />
        }
        @if (auth.can('run') && launchable()) {
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
  private readonly review = inject(ReviewStateService);
  protected readonly auth = inject(AuthService);
  protected readonly busy = this.store.busy;

  readonly order = input.required<DevelopmentItem>();
  protected readonly state = this.review.state;
  /** Review-Container, der diesen Auftrag zeigt (bzw. für ihn angefordert ist). */
  protected readonly shown = computed(() => orderReviewSlot(this.state()?.slots, this.order().id));
  protected readonly launchable = computed(() => reviewLaunchable(this.shown()));

  constructor() {
    // Ein gemeinsamer Poll für alle Boxen (Freigabe und Abnahme), nur solange eine angezeigt wird.
    inject(DestroyRef).onDestroy(this.review.subscribe());
  }

  protected start(item: DevelopmentItem): Promise<void> {
    return this.review.launch(item);
  }
}
