import { Component, effect, inject, signal, untracked } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import { ProjectStore } from '../../core/project-store.js';

export interface QualityStats {
  days: number;
  orders: { finished: number; firstTry: number; firstTryRate: number | null };
  corrections: { count: number; succeeded: number; rate: number | null };
  transient: { count: number; succeeded: number; rate: number | null };
  blocked: { resolved: number; avgHours: number | null; open: number; longestOpenHours: number | null };
  budgetStops: number;
  agents: { agent: string; engine: string; steps: number; failed: number; failRate: number }[];
}

/** „Was klappt“: Erfolg beim ersten Versuch, Nachbesserung, Wiederholungen, Blockierdauer, Fehler je Agent. */
@Component({
  selector: 'app-quality-panel',
  standalone: true,
  template: `
    @if (quality(); as q) {
      <section class="panel quality-panel" aria-labelledby="quality-title">
        <div class="section-heading">
          <div>
            <h2 id="quality-title">Was klappt</h2>
            <p class="muted">Letzte {{ q.days }} Tage – wo der Ablauf hilft und wo Aufträge hängen bleiben</p>
          </div>
        </div>
        <div class="summary-grid">
          <div class="summary-card">
            <strong>{{ percent(q.orders.firstTryRate) }}</strong>
            <span>beim ersten Versuch erledigt ({{ q.orders.firstTry }} von {{ q.orders.finished }})</span>
          </div>
          <div class="summary-card">
            <strong>{{ percent(q.corrections.rate) }}</strong>
            <span>Nachbesserungen erfolgreich ({{ q.corrections.succeeded }} von {{ q.corrections.count }})</span>
          </div>
          <div class="summary-card">
            <strong>{{ percent(q.transient.rate) }}</strong>
            <span
              >Wiederholungen nach kurzem Ausfall erfolgreich ({{ q.transient.succeeded }} von
              {{ q.transient.count }})</span
            >
          </div>
          <div class="summary-card">
            <strong>{{ q.blocked.avgHours === null ? '–' : q.blocked.avgHours + ' h' }}</strong>
            <span
              >im Schnitt blockiert ({{ q.blocked.open }} jetzt blockiert{{
                q.blocked.longestOpenHours === null ? '' : ', längster seit ' + q.blocked.longestOpenHours + ' h'
              }})</span
            >
          </div>
        </div>
        @if (q.budgetStops) {
          <p class="muted">{{ q.budgetStops }} Auftrag/Aufträge an der Kostengrenze angehalten.</p>
        }
        @if (q.agents.length) {
          <table class="quality-agents">
            <caption class="muted">
              Fehlschläge je Agent und Werkzeug
            </caption>
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Werkzeug</th>
                <th scope="col">Schritte</th>
                <th scope="col">Gescheitert</th>
              </tr>
            </thead>
            <tbody>
              @for (row of q.agents; track row.agent + row.engine) {
                <tr>
                  <td>{{ row.agent }}</td>
                  <td>{{ row.engine }}</td>
                  <td>{{ row.steps }}</td>
                  <td>
                    <span class="share-cell">
                      <span class="bar-track"><span [style.width.%]="row.failRate"></span></span>
                      {{ row.failed }} ({{ row.failRate }} %)
                    </span>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        }
      </section>
    }
  `,
})
export class QualityPanelComponent {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);
  protected readonly quality = signal<QualityStats | null>(null);

  constructor() {
    effect(() => {
      const slug = this.store.activeProject();
      this.quality.set(null);
      if (slug) untracked(() => void this.load(slug));
    });
  }

  protected percent(value: number | null): string {
    return value === null ? '–' : `${value} %`;
  }

  private async load(slug: string): Promise<void> {
    const result = await this.api.get<QualityStats>(`${this.api.projectPath(slug)}/quality`).catch(() => null);
    if (slug === this.store.activeProject()) this.quality.set(result);
  }
}
