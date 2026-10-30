import { Component, computed, input } from '@angular/core';
import type { ReviewSlot } from '../../core/models.js';
import { WaitStatusComponent } from '../runs/wait-status.component.js';
import { reviewInstanceLabel } from './review-box.js';

/** Stand des Review-Containers eines Auftrags: Statuspunkt, Link, Wartestatus und bei einem Fehler das Log. */
@Component({
  selector: 'app-review-slot-status',
  standalone: true,
  imports: [WaitStatusComponent],
  template: `
    @let current = slot();
    <p class="approval-instance">
      <span class="approval-dot" [class]="current.status"></span>
      {{ current.status === 'running' && wait.status() ? 'Review ' + current.slot : instanceLabel() }}
      @if (current.status === 'running') {
        · <a [href]="current.url" target="_blank" rel="noopener">Review {{ current.slot }} öffnen ↗</a>
      }
    </p>
    <app-wait-status #wait />
    @if (current.status === 'failed' && current.message) {
      <pre class="approval-log">{{ current.message }}</pre>
    }
  `,
  host: { style: 'display: contents' },
})
export class ReviewSlotStatusComponent {
  readonly slot = input.required<ReviewSlot>();
  protected readonly instanceLabel = computed(() => reviewInstanceLabel(this.slot()));
}
