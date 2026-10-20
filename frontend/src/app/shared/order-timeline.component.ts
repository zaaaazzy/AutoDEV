import { DatePipe } from '@angular/common';
import { Component, DestroyRef, effect, inject, input, signal } from '@angular/core';
import { ApiService } from '../core/api.service.js';
import type { DevelopmentItem } from '../core/models.js';
import { visibleTimelineEntries, type OrderTimeline, type TimelineEntry } from './timeline-entries.js';

const KIND_LABEL: Record<TimelineEntry['kind'], string> = {
  created: 'Auftrag',
  status: 'Status',
  step: 'Agent',
  analysis: 'Analyse',
  question: 'Rückfrage',
  answer: 'Antwort',
  bugfix: 'Bugfix',
};

/**
 * Zeitleiste eines Auftrags (GET /api/development/:id/timeline): oben in einem Satz, worauf der Auftrag gerade
 * wartet; aufklappbar, wer wann was gemacht hat. Während der Auftrag läuft, aktualisiert sie sich alle 10 s.
 */
@Component({
  selector: 'app-order-timeline',
  standalone: true,
  imports: [DatePipe],
  // Der Inhalt zwischen den Tags (z. B. Status- und Sprintwahl) steht zwischen „Stand“ und Zeitleiste:
  // So zeigt der Auftrag zuerst, worauf er wartet, ohne die Zeitleiste ein zweites Mal zu laden.
  template: `
    @if (timeline(); as current) {
      <p class="order-waiting" [attr.data-tone]="current.waiting.tone">
        <span class="order-waiting-label">Stand</span> {{ current.waiting.label }}
      </p>
    }
    <ng-content />
    @if (timeline(); as current) {
      @let entries = visible(current.entries);
      <details class="run-step order-brief order-timeline">
        <summary>
          Zeitleiste <span class="count">{{ entries.length }}</span>
        </summary>
        <ol>
          @for (entry of entries; track $index) {
            <li [attr.data-state]="entry.state ?? 'info'">
              <time [attr.datetime]="entry.at">{{ entry.at | date: 'dd.MM. HH:mm' }}</time>
              <span class="order-timeline-kind">{{ kindLabel(entry.kind) }}</span>
              <span class="order-timeline-title">{{ entry.title }}</span>
              @if (entry.detail) {
                <small class="muted">{{ entry.detail }}</small>
              }
            </li>
          }
        </ol>
      </details>
    }
  `,
  host: { style: 'display: contents' },
})
export class OrderTimelineComponent {
  private readonly api = inject(ApiService);
  readonly order = input.required<DevelopmentItem>();
  protected readonly timeline = signal<OrderTimeline | null>(null);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stopPolling());
    effect(() => {
      const item = this.order();
      // Neu laden, sobald sich Status, Analyse oder Aktion des Auftrags ändern.
      void item.status;
      void item.analysisStatus;
      void item.actionTodo;
      void this.load(item.id);
      this.stopPolling();
      if (item.status === 'in_progress') this.timer = setInterval(() => void this.load(item.id), 10_000);
    });
  }

  protected readonly visible = visibleTimelineEntries;

  protected kindLabel(kind: TimelineEntry['kind']): string {
    return KIND_LABEL[kind];
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async load(id: string): Promise<void> {
    const result = await this.api
      .get<OrderTimeline>(`/api/development/${encodeURIComponent(id)}/timeline`)
      .catch(() => null);
    if (id !== this.order().id) return;
    this.timeline.set(result);
  }
}
