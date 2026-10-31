import { Component, DestroyRef, computed, inject, input } from '@angular/core';
import type { DevelopmentItem } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { OrderService } from './order.service.js';
import { freeReviewSlot, orderReviewSlot, reviewLaunchable } from './review-box.js';
import { ReviewSlotStatusComponent } from './review-slot-status.component.js';
import { ReviewStateService } from './review-state.service.js';
import { GitAlertComponent } from '../../shared/git-alert.component.js';

/**
 * Review-Freigabe eines Auftrags: Er ist fertig und getestet, aber noch nicht im Sprint-Branch. In der Review-Instanz
 * (eigener Port, eigene Datenbank-Kopie) ansehen, dann freigeben (wird gemergt) oder mit Rückmeldung zurückweisen.
 */
@Component({
  selector: 'app-order-approval',
  standalone: true,
  imports: [GitAlertComponent, ReviewSlotStatusComponent],
  template: `
    @let item = order();
    <div class="approval-box">
      <strong>👀 Wartet auf deine Freigabe</strong>
      @if (item.reviewApprovedAt) {
        <p>
          ✓ Freigegeben – wird gemergt, sobald der Worker zwischen zwei Aufträgen ist. Danach zeigt die Vorschau den
          neuen Stand.
        </p>
      } @else {
        <p>
          Der Auftrag ist fertig und getestet, aber noch nicht in den Sprint-Branch gemergt.
          @if (state()?.configured) {
            Sieh ihn dir im Review-Container an und gib ihn frei – erst dann wird er gemergt.
          } @else {
            Prüfe die Änderungen und gib ihn frei – erst dann wird er gemergt.
          }
        </p>
      }
      @if (state(); as review) {
        @if (!review.configured) {
          <p class="muted">Kein Review-Befehl eingestellt – unter Einstellungen → Review-Freigabe ergänzen.</p>
        } @else if (shown(); as slot) {
          <app-review-slot-status [slot]="slot" />
        } @else if (!review.slots.some(free)) {
          <p class="muted">
            Alle Review-Container sind belegt – mit „Im Review-Container anzeigen“ übernimmst du einen.
          </p>
        } @else {
          <p class="muted">Wird gleich in einem freien Review-Container gestartet …</p>
        }
      }
      @if (!item.reviewApprovedAt) {
        <app-git-alert action="approve" />
        <div class="actions">
          @if (withActions()) {
            <button class="button primary" type="button" [disabled]="busy()" (click)="approve(item)">
              ✓ Freigeben
            </button>
            <button class="button secondary" type="button" [disabled]="busy()" (click)="reject(item)">
              ↩ Zurückweisen
            </button>
          }
          @if (state()?.configured && launchable()) {
            <button class="button secondary" type="button" [disabled]="busy()" (click)="show(item)">
              {{ shown() ? '↻ Review-Container neu starten' : '👀 Im Review-Container anzeigen' }}
            </button>
          }
        </div>
      }
    </div>
  `,
})
export class OrderApprovalComponent {
  private readonly store = inject(ProjectStore);
  private readonly orders = inject(OrderService);
  private readonly review = inject(ReviewStateService);
  protected readonly busy = this.store.busy;

  readonly order = input.required<DevelopmentItem>();
  /** false: Freigeben/Zurückweisen stehen anderswo (Aktionszeile unter „Aktionen“). */
  readonly withActions = input(true);
  protected readonly state = this.review.state;
  /** Review-Container, der diesen Auftrag zeigt (bzw. für ihn angefordert ist). */
  protected readonly shown = computed(() => orderReviewSlot(this.state()?.slots, this.order().id));
  protected readonly launchable = computed(() => reviewLaunchable(this.shown()));
  protected readonly free = freeReviewSlot;

  constructor() {
    // Solange der Auftrag wartet, den Stand der Review-Instanz nachladen – ein gemeinsamer Poll für alle Boxen.
    inject(DestroyRef).onDestroy(this.review.subscribe());
  }

  protected approve(item: DevelopmentItem): Promise<void> {
    return this.orders.approve(item);
  }

  protected reject(item: DevelopmentItem): Promise<void> {
    return this.orders.rejectReview(item);
  }

  protected show(item: DevelopmentItem): Promise<void> {
    return this.review.launch(item);
  }
}
