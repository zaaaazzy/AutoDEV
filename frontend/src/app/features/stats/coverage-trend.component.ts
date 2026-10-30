import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, effect, inject, signal, untracked } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import type { CoverageTrend, CoverageTrendPoint } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { CHART, linePath, plotted, yPosition } from './coverage-trend.js';

/** Ab dieser Zeilenabdeckung gilt ein Bereich als ausreichend getestet (wie beim Tester). */
const TARGET = 75;

/** Testabdeckung über die Zeit: je fester Bereich eine Zeitreihe aus Zeilen %, Zweige % und Anzahl Tests. */
@Component({
  selector: 'app-coverage-trend',
  standalone: true,
  imports: [DatePipe, DecimalPipe],
  template: `
    <section class="panel coverage-trend" aria-labelledby="coverage-trend-title" data-testid="stats-coverage-trend">
      <div class="section-heading">
        <div>
          <h2 id="coverage-trend-title">Testabdeckung im Verlauf</h2>
          <p class="muted">Je Bereich: Zeilen- und Zweigabdeckung jeder Messung · Ziel {{ target }} % Zeilen</p>
        </div>
      </div>
      @if (!project()) {
        <p class="empty-state">Kein Projekt ausgewählt.</p>
      } @else if (error()) {
        <p class="muted">Verlauf der Testabdeckung konnte nicht geladen werden.</p>
      } @else if (trend(); as data) {
        @if (hasData(data)) {
          <p class="coverage-trend-legend muted" aria-hidden="true">
            <span class="legend-lines">Zeilen %</span>
            <span class="legend-branches">Zweige %</span>
            <span class="legend-target">Ziel {{ target }} %</span>
          </p>
          <div class="coverage-trend-grid">
            @for (entry of data.areas; track entry.area) {
              <article class="coverage-trend-area">
                <h3>{{ entry.area }}</h3>
                @if (entry.points.length) {
                  <svg
                    [attr.viewBox]="'0 0 ' + chart.width + ' ' + chart.height"
                    role="img"
                    [attr.aria-label]="'Verlauf ' + entry.area + ', ' + entry.points.length + ' Messungen'"
                  >
                    @for (tick of [0, 50, 100]; track tick) {
                      <line class="grid" [attr.x1]="chart.left" [attr.x2]="chart.width - chart.right"
                        [attr.y1]="y(tick)" [attr.y2]="y(tick)" />
                      <text class="axis" [attr.x]="chart.left - 4" [attr.y]="y(tick) + 3">{{ tick }}</text>
                    }
                    <line class="target" [attr.x1]="chart.left" [attr.x2]="chart.width - chart.right"
                      [attr.y1]="y(target)" [attr.y2]="y(target)" />
                    @let lines = plotted(entry.points, 'lines');
                    @let branches = plotted(entry.points, 'branches');
                    <path class="series-lines" [attr.d]="linePath(lines)" />
                    <path class="series-branches" [attr.d]="linePath(branches)" />
                    @for (point of lines; track $index) {
                      @if (point) {
                        <circle class="series-lines" [attr.cx]="point.x" [attr.cy]="point.y" r="4">
                          <title>{{ tooltip(point.point) }}</title>
                        </circle>
                      }
                    }
                    @for (point of branches; track $index) {
                      @if (point) {
                        <rect class="series-branches" [attr.x]="point.x - 4" [attr.y]="point.y - 4" width="8" height="8">
                          <title>{{ tooltip(point.point) }}</title>
                        </rect>
                      }
                    }
                  </svg>
                  <details>
                    <summary>Messungen als Tabelle ({{ entry.points.length }})</summary>
                    <div class="table-wrap">
                      <table class="coverage-trend-table">
                        <thead>
                          <tr>
                            <th scope="col">Datum</th>
                            <th scope="col">Zeilen %</th>
                            <th scope="col">Zweige %</th>
                            <th scope="col">Tests gesamt</th>
                          </tr>
                        </thead>
                        <tbody>
                          @for (point of entry.points; track point.reportId) {
                            <tr>
                              <td>{{ point.date | date: 'dd.MM.yyyy HH:mm' }}</td>
                              <td>{{ point.lines === null ? '–' : (point.lines | number: '1.0-1') }}</td>
                              <td>{{ point.branches === null ? '–' : (point.branches | number: '1.0-1') }}</td>
                              <td>{{ point.tests }}</td>
                            </tr>
                          }
                        </tbody>
                      </table>
                    </div>
                  </details>
                } @else {
                  <p class="empty-state">Noch keine Messung für diesen Bereich.</p>
                }
              </article>
            }
          </div>
        } @else {
          <p class="empty-state">Noch keine Testabdeckung gemessen.</p>
        }
      } @else {
        <p class="loading" role="status">Verlauf wird geladen …</p>
      }
    </section>
  `,
})
export class CoverageTrendComponent {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);
  protected readonly project = this.store.activeProject;
  protected readonly trend = signal<CoverageTrend | null>(null);
  protected readonly error = signal(false);
  protected readonly chart = CHART;
  protected readonly target = TARGET;
  protected readonly y = yPosition;
  protected readonly plotted = plotted;
  protected readonly linePath = linePath;

  constructor() {
    effect(() => {
      const slug = this.store.activeProject();
      this.trend.set(null);
      this.error.set(false);
      if (slug) untracked(() => void this.load(slug));
    });
  }

  protected hasData(data: CoverageTrend): boolean {
    return data.areas.some((entry) => entry.points.length > 0);
  }

  protected tooltip(point: CoverageTrendPoint): string {
    const percent = (value: number | null) =>
      value === null ? '–' : `${value.toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`;
    const date = new Date(point.date).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
    return `${date} · Zeilen ${percent(point.lines)} · Zweige ${percent(point.branches)} · ${point.tests} Tests`;
  }

  private async load(slug: string): Promise<void> {
    try {
      const result = await this.api.get<CoverageTrend>(`${this.api.projectPath(slug)}/coverage/trend`);
      if (slug === this.store.activeProject()) this.trend.set(result);
    } catch {
      if (slug === this.store.activeProject()) this.error.set(true);
    }
  }
}
