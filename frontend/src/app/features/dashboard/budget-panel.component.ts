import { Component, effect, inject, signal, untracked } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import type { BudgetOverview } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { BudgetMeterComponent } from '../../shared/budget-meter.component.js';

/** Dashboard-Kachel „Budget heute / Sprint“: Verbrauch gegen die Limits als Fortschrittsbalken. */
@Component({
  selector: 'app-budget-panel',
  standalone: true,
  imports: [BudgetMeterComponent],
  template: `
    @if (overview(); as current) {
      @if (current.status.length) {
        <div class="budget-panel" data-testid="budget-panel">
          <a class="share-label" href="#settings" (click)="$event.preventDefault(); store.navigate('settings')"
            >Budget heute / Sprint</a
          >
          <app-budget-meter [status]="current.status" [display]="current" [warnPercent]="current.warnPercent" />
        </div>
      }
    }
  `,
})
export class BudgetPanelComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  protected readonly overview = signal<BudgetOverview | null>(null);

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
      const overview = await this.api.get<BudgetOverview>(`${this.api.projectPath(slug)}/budget`);
      if (this.store.isActive(slug)) this.overview.set(overview);
    } catch {
      if (this.store.isActive(slug)) this.overview.set(null);
    }
  }
}
