import { Component, input } from '@angular/core';
import type { BudgetOverview, BudgetPeriod, BudgetStatus } from '../core/models.js';
import { formatMoney, formatNumber } from './format.js';

export const PERIOD_LABELS: Record<BudgetPeriod, string> = {
  day: 'Heute',
  sprint: 'Sprint',
  order: 'Auftrag',
};

/** Verbrauch gegen Budget als Fortschrittsbalken: je Zeitraum Tokens bzw. Kosten, ab 80 % orange, ab 100 % rot. */
@Component({
  selector: 'app-budget-meter',
  standalone: true,
  template: `
    <div class="budget-meter">
      @for (entry of status(); track entry.period) {
        <div class="budget-meter-row" [attr.data-period]="entry.period">
          <div class="budget-meter-head">
            <strong>{{ label(entry.period) }}</strong>
            <span class="muted">{{ detail(entry) }} · {{ percentText(entry) }}</span>
          </div>
          <div
            class="bar-track"
            role="progressbar"
            [attr.aria-label]="'Budget ' + label(entry.period)"
            [attr.aria-valuenow]="entry.percent"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <span
              [style.width.%]="width(entry)"
              [class.warn]="entry.percent >= warnPercent() && entry.percent < 100"
              [class.bad]="entry.percent >= 100"
            ></span>
          </div>
        </div>
      } @empty {
        <p class="muted">Kein Budget gesetzt – der Verbrauch ist unbegrenzt.</p>
      }
    </div>
  `,
})
export class BudgetMeterComponent {
  readonly status = input.required<BudgetStatus[]>();
  readonly display = input<Pick<BudgetOverview, 'currency' | 'chfPerUsd'> | null>(null);
  readonly warnPercent = input(80);

  protected label(period: BudgetPeriod): string {
    return PERIOD_LABELS[period];
  }

  protected width(entry: BudgetStatus): number {
    return Math.min(100, Math.max(0, entry.percent));
  }

  protected percentText(entry: BudgetStatus): string {
    return `${Math.round(entry.percent)} %`;
  }

  /** Beide gesetzten Grenzen: „12.000 von 50.000 Tokens · 1,20 von 5,00 USD“. */
  protected detail(entry: BudgetStatus): string {
    const parts: string[] = [];
    if (entry.limit.maxTokens !== null)
      parts.push(`${formatNumber(entry.spend.tokens)} von ${formatNumber(entry.limit.maxTokens)} Tokens`);
    if (entry.limit.maxCostUsd !== null)
      parts.push(
        `${formatMoney(entry.spend.costUsd, this.display())} von ${formatMoney(entry.limit.maxCostUsd, this.display())}`,
      );
    return parts.join(' · ');
  }
}
