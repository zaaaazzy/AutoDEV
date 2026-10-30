import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import type { ProviderLimit } from '../../core/models.js';
import { visibleInterval } from '../../core/visible-interval.js';
import { activeLimits, limitText } from './provider-limits.js';

const POLL_MS = 60_000;

/**
 * Hinweis im Dashboard, sobald das Konto eines Agent-Anbieters (Claude …) sein Nutzungslimit erreicht hat: bis wann
 * die Agents pausieren, Link zur Verbrauchs- bzw. Bezahlseite und – falls erlaubt – „Fortsetzen“ nach dem Erhöhen.
 */
@Component({
  selector: 'app-provider-limit-alert',
  standalone: true,
  template: `
    @let limits = shown();
    @if (limits.length) {
      <section class="git-alert block" role="status" aria-live="polite" data-testid="provider-limit-alert">
        <header><strong>Token bzw. Nutzungslimit aufgebraucht</strong></header>
        <ul>
          @for (limit of limits; track limit.provider) {
            <li>
              <span class="git-alert-title">{{ limit.label }}</span>
              <span class="git-alert-detail">{{ text(limit) }}</span>
              <span class="git-alert-fixes">
                @if (limit.actions.pay) {
                  <a class="button secondary small" [href]="limit.paymentUrl" target="_blank" rel="noopener noreferrer"
                    >Limit erhöhen bei {{ limit.label }}</a
                  >
                }
                @if (limit.actions.resume) {
                  <button
                    type="button"
                    class="button secondary small"
                    [disabled]="busy()"
                    title="Nach dem Erhöhen: wartende Aufträge sofort wieder starten"
                    (click)="resume(limit)"
                  >
                    Limit erhöht – fortsetzen
                  </button>
                }
              </span>
            </li>
          }
        </ul>
        @if (message()) {
          <p class="git-alert-status">{{ message() }}</p>
        }
      </section>
    }
  `,
})
export class ProviderLimitAlertComponent {
  private readonly api = inject(ApiService);
  private readonly providers = signal<ProviderLimit[]>([]);
  private readonly now = signal(new Date());
  protected readonly busy = signal(false);
  protected readonly message = signal('');
  protected readonly shown = computed(() => activeLimits(this.providers(), this.now()));

  constructor() {
    void this.load();
    inject(DestroyRef).onDestroy(visibleInterval(() => void this.load(), POLL_MS));
  }

  protected text(limit: ProviderLimit): string {
    return limitText(limit);
  }

  protected async resume(limit: ProviderLimit): Promise<void> {
    this.busy.set(true);
    try {
      const { released } = await this.api.post<{ released: number }>(
        `/api/agent-limits/${encodeURIComponent(limit.provider)}/resume`,
      );
      this.message.set(`${limit.label}: fortgesetzt, ${released} wartende Aufträge starten wieder.`);
    } catch {
      this.message.set(`${limit.label}: Fortsetzen ist nicht möglich.`);
    } finally {
      this.busy.set(false);
      await this.load();
    }
  }

  private async load(): Promise<void> {
    try {
      const { providers } = await this.api.get<{ providers: ProviderLimit[] }>('/api/agent-limits');
      this.providers.set(providers);
    } catch {
      // Ohne Antwort kein Hinweis: der Status ist nur eine Anzeige.
      this.providers.set([]);
    }
    this.now.set(new Date());
  }
}
