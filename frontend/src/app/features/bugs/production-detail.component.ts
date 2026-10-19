import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import type { ProductionEvent } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { DateTimePipe } from '../../shared/pipes.js';

const SOURCE_LABEL: Record<ProductionEvent['source'], string> = {
  health: 'Health-Check',
  logs: 'Compose-Logs',
  ingest: 'Ingest',
};

/**
 * Bug-Detail für Betriebs-Bugs: Vorkommen je Stunde (48 h), gebündelte Ereignisse mit maskiertem Beispiel und der
 * Deploy-Verdacht. Beispiele erscheinen als reiner Text, nie als HTML.
 */
@Component({
  selector: 'app-production-detail',
  standalone: true,
  imports: [DateTimePipe],
  templateUrl: './production-detail.component.html',
  host: { style: 'display: contents' },
})
export class ProductionDetailComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  readonly bugId = input.required<string>();
  protected readonly events = signal<ProductionEvent[]>([]);
  protected readonly history = signal<{ hour: string; count: number }[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly sourceLabel = SOURCE_LABEL;
  protected readonly peak = computed(() => Math.max(1, ...this.history().map((entry) => entry.count)));
  protected readonly total = computed(() => this.history().reduce((sum, entry) => sum + entry.count, 0));

  constructor() {
    effect(() => {
      const id = this.bugId();
      this.store.foregroundLoads();
      void this.load(id);
    });
  }

  private async load(id: string): Promise<void> {
    try {
      const result = await this.api.get<{ events: ProductionEvent[]; history: { hour: string; count: number }[] }>(
        `/api/bugs/${encodeURIComponent(id)}/production`,
      );
      this.events.set(result.events ?? []);
      this.history.set(result.history ?? []);
      this.error.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Verlauf konnte nicht geladen werden.');
    }
  }

  protected hourLabel(hour: string): string {
    return new Date(hour).toLocaleString('de-CH', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }

  protected barHeight(count: number): number {
    return count ? Math.max(4, (count / this.peak()) * 100) : 0;
  }
}
