import { Component, DestroyRef, computed, inject, input } from '@angular/core';
import type { DevelopmentItem, ReviewSlot } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { OrderService } from './order.service.js';
import { ReviewStateService } from './review-state.service.js';

/**
 * Review-Freigabe eines Auftrags: Er ist fertig und getestet, aber noch nicht im Sprint-Branch. In der Review-Instanz
 * (eigener Port, eigene Datenbank-Kopie) ansehen, dann freigeben (wird gemergt) oder mit Rückmeldung zurückweisen.
 */
@Component({
  selector: 'app-order-approval',
  standalone: true,
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
          Der Auftrag ist fertig und getestet, aber noch nicht im Sprint. Sieh ihn dir im Review-Container an und gib
          ihn frei – erst dann wird er gemergt.
        </p>
      }
      @if (state(); as review) {
        @if (!review.configured) {
          <p class="muted">Kein Review-Befehl eingestellt – unter Einstellungen → Review-Freigabe ergänzen.</p>
        } @else if (shown(); as slot) {
          <p class="approval-instance">
            <span class="approval-dot" [class]="slot.status"></span>
            {{ instanceLabel() }}
            @if (slot.status === 'running') {
              · <a [href]="slot.url" target="_blank" rel="noopener">Review {{ slot.slot }} öffnen ↗</a>
            }
          </p>
          @if (slot.status === 'failed' && slot.message) {
            <pre class="approval-log">{{ slot.message }}</pre>
          }
        } @else if (!review.slots.some(free)) {
          <p class="muted">
            Alle Review-Container sind belegt – mit „Im Review-Container anzeigen“ übernimmst du einen.
          </p>
        } @else {
          <p class="muted">Wird gleich in einem freien Review-Container gestartet …</p>
        }
      }
      @if (!item.reviewApprovedAt) {
        <div class="actions">
          <button class="button primary" type="button" [disabled]="busy()" (click)="approve(item)">✓ Freigeben</button>
          <button class="button secondary" type="button" [disabled]="busy()" (click)="reject(item)">
            ↩ Zurückweisen
          </button>
          @if (state()?.configured && (!shown() || shown()?.status === 'failed')) {
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
  protected readonly state = this.review.state;
  /** Review-Container, der diesen Auftrag zeigt (bzw. für ihn angefordert ist). */
  protected readonly shown = computed(
    () => this.state()?.slots.find((slot) => slot.developmentId === this.order().id && slot.status !== 'idle') ?? null,
  );
  protected readonly free = (slot: ReviewSlot): boolean => slot.enabled && slot.status === 'idle';
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
    // Solange der Auftrag wartet, den Stand der Review-Instanz nachladen – ein gemeinsamer Poll für alle Boxen.
    inject(DestroyRef).onDestroy(this.review.subscribe());
  }

  protected approve(item: DevelopmentItem): Promise<void> {
    return this.orders.approve(item);
  }

  protected reject(item: DevelopmentItem): Promise<void> {
    return this.orders.rejectReview(item);
  }

  protected async show(item: DevelopmentItem): Promise<void> {
    await this.orders.showReview(item);
    await this.review.refresh();
  }
}
