import { Component, effect, inject, signal, untracked } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import type { ProductionStatus } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';

/**
 * Kachel „Betrieb“: grün bei gesunder Anwendung, rot bei Health-Ausfall oder offenem kritischem Betriebs-Bug.
 * Ein Klick öffnet die offenen Betriebs-Bugs bzw. ohne Einrichtung die Einstellungen.
 */
@Component({
  selector: 'app-production-tile',
  standalone: true,
  template: `
    @if (status(); as current) {
      <a
        class="summary-card production-tile"
        [class.tone-healthy]="current.healthy"
        [class.tone-failing]="!current.healthy"
        [class.tone-idle]="!current.configured && current.healthy"
        [href]="current.configured ? '#bugs' : '#settings'"
        (click)="$event.preventDefault(); open(current)"
        data-testid="production-tile"
      >
        <strong>
          <span class="production-icon" aria-hidden="true">{{ current.healthy ? '✓' : '⚠' }}</span>
          {{ headline(current) }}
        </strong>
        <span
          >Betrieb ·
          @if (current.down) {
            Anwendung nicht erreichbar
          } @else if (current.criticalBugs) {
            {{ current.criticalBugs }} kritische{{ current.criticalBugs === 1 ? 'r' : '' }} Fehler
          } @else {
            {{ current.last24h }}× Fehler seit gestern
          }
        </span>
      </a>
    }
  `,
  host: { style: 'display: contents' },
})
export class ProductionTileComponent {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);
  protected readonly status = signal<ProductionStatus | null>(null);

  constructor() {
    effect(() => {
      const slug = this.store.activeProject();
      this.store.foregroundLoads();
      untracked(() => void this.load(slug));
    });
  }

  private async load(slug: string): Promise<void> {
    if (!slug) return;
    try {
      const result = await this.api.get<{ production: ProductionStatus }>(`${this.api.projectPath(slug)}/production`);
      if (this.store.isActive(slug)) this.status.set(result.production);
    } catch {
      if (this.store.isActive(slug)) this.status.set(null);
    }
  }

  protected headline(current: ProductionStatus): string {
    if (current.down) return 'Ausfall';
    if (!current.healthy) return 'Kritisch';
    return current.configured ? 'Gesund' : 'Nicht eingerichtet';
  }

  protected open(current: ProductionStatus): void {
    if (!current.configured) return this.store.navigate('settings', { anchor: 'production-settings' });
    this.store.navigate('bugs', { filters: { source: ['Betrieb'] } });
  }
}
