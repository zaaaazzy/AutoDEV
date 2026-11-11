import { Component, computed, inject, input } from '@angular/core';
import { AuthService } from '../../core/auth.service.js';
import type { AcceptanceCheck, DevelopmentItem } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { AcceptanceTicks } from '../../shared/acceptance-ticks.js';
import { actionHint } from '../actions/action-hints.js';
import { OrderService } from './order.service.js';

/** Kurztext unter einem offenen Punkt, wenn der Tester keinen eigenen Hinweis hinterlassen hat. */
const STATUS_NOTES: Partial<Record<AcceptanceCheck['status'], string>> = {
  manual: '👤 Nur von Hand prüfbar',
  unmet: 'Vom Tester als nicht erfüllt gemeldet',
};

/**
 * Offene Abnahmepunkte eines Auftrags – dieselbe Liste unter „Aktionen“ und in der Auftragsansicht: abhaken, einzeln
 * oder gesammelt vom Tester prüfen lassen, unter „Aktionen“ zusätzlich alle manuellen Punkte auf einmal als geprüft
 * vermerken. Erfüllte Punkte stehen eingeklappt dahinter, damit die Liste mit dem beginnt, was noch zu tun ist.
 */
@Component({
  selector: 'app-acceptance-list',
  standalone: true,
  template: `
    @let item = order();
    <ul class="todo-list acceptance-todo-list">
      @for (check of checks(); track check.kind + check.position) {
        <li [class.verifying]="isVerifying(check)" [class.manual]="check.status === 'manual'">
          <input
            type="checkbox"
            [checked]="ticks.saving(item.id, check)"
            [disabled]="busy() || isVerifying(check) || !auth.can('plan')"
            [attr.aria-label]="'Abhaken: ' + check.text"
            [title]="auth.can('plan') ? 'Als erfüllt abhaken' : 'Abhaken braucht das Recht „Planung“.'"
            (change)="tickPoint($event, item, check)"
          />
          <span class="todo-text"
            >{{ check.text }}
            @if (isVerifying(check)) {
              <small class="todo-state">🤖 Tester prüft …</small>
            } @else if (check.note) {
              <small class="muted">{{ check.note }}</small>
            } @else if (statusNote(check); as note) {
              <small class="muted">{{ note }}</small>
            }
          </span>
          @if (auth.can('plan')) {
            <button
              type="button"
              class="todo-verify"
              [title]="hint('🤖 Prüfen')"
              [disabled]="busy() || isVerifying(check)"
              (click)="verifyPoints(item, check)"
            >
              🤖 Prüfen
            </button>
          }
        </li>
      }
    </ul>
    <div class="acceptance-foot">
      @if (auth.can('plan') && checks().length > 1) {
        <button
          class="button secondary small"
          type="button"
          [title]="hint('🤖 Alle automatisch prüfen')"
          [disabled]="busy() || verifying()"
          (click)="verifyPoints(item)"
        >
          🤖 Alle automatisch prüfen
        </button>
      }
      @if (confirmable() && auth.can('plan') && manual()) {
        <button
          class="button secondary small"
          type="button"
          [title]="hint('Geprüft – alles in Ordnung')"
          [disabled]="busy()"
          (click)="confirm(item)"
        >
          Geprüft – alles in Ordnung
        </button>
      }
      <ng-content />
      <p class="muted small acceptance-hint">
        Offen, bis du den Punkt abhakst oder der Tester ihn als erfüllt bestätigt.
      </p>
    </div>
    @if (met().length) {
      <details class="acceptance-met">
        <summary>Erfüllte Punkte ({{ met().length }})</summary>
        <ul class="acceptance-list plain-list">
          @for (check of met(); track check.kind + check.position) {
            <li class="acceptance-met">
              <span class="acceptance-mark" aria-label="erfüllt">✓</span>
              <span
                >{{ check.text }}
                @if (check.note) {
                  <small class="muted">{{ check.note }}</small>
                }
              </span>
            </li>
          }
        </ul>
      </details>
    }
  `,
})
export class AcceptanceListComponent {
  private readonly orders = inject(OrderService);
  private readonly store = inject(ProjectStore);
  protected readonly auth = inject(AuthService);
  protected readonly busy = this.store.busy;
  /** Häkchen der offenen Abnahmepunkte: gesetzt nur während des Speicherns, nach Fehler wieder leer. */
  protected readonly ticks = new AcceptanceTicks();

  readonly order = input.required<DevelopmentItem>();
  /** Offene Punkte in Anzeigereihenfolge. */
  readonly checks = input.required<AcceptanceCheck[]>();
  /** Erfüllte Punkte, eingeklappt unter der Liste; leer lässt den Abschnitt weg. */
  readonly met = input<AcceptanceCheck[]>([]);
  /** „Geprüft – alles in Ordnung“ anbieten (vermerkt alle manuellen Punkte als geprüft). */
  readonly confirmable = input(false);

  protected readonly verifying = computed(() => this.checks().some((check) => this.isVerifying(check)));
  protected readonly manual = computed(() => this.checks().some((check) => check.status === 'manual'));

  protected isVerifying(check: AcceptanceCheck): boolean {
    return check.status === 'verifying' || check.status === 'checking';
  }

  protected statusNote(check: AcceptanceCheck): string | null {
    return STATUS_NOTES[check.status] ?? null;
  }

  protected hint(label: string): string {
    return actionHint(label);
  }

  protected tickPoint(event: Event, item: DevelopmentItem, check: AcceptanceCheck): Promise<void> {
    return this.ticks.tick(event.target as HTMLInputElement, item.id, check, () =>
      this.orders.checkPoint(item, check, true),
    );
  }

  protected verifyPoints(item: DevelopmentItem, check?: AcceptanceCheck): Promise<void> {
    return this.orders.verifyPoints(item, check);
  }

  protected confirm(item: DevelopmentItem): Promise<void> {
    return this.orders.confirmChecks(item);
  }
}
