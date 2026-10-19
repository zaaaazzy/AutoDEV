import { DatePipe } from '@angular/common';
import { Component, DestroyRef, effect, inject, input, signal } from '@angular/core';
import { ApiService } from '../core/api.service.js';
import type { DevelopmentItem } from '../core/models.js';

export interface TimelineEntry {
  at: string;
  kind: 'created' | 'status' | 'step' | 'analysis' | 'question' | 'answer' | 'bugfix';
  title: string;
  detail?: string;
  state?: 'passed' | 'failed' | 'running' | 'info';
}

export interface OrderTimeline {
  waiting: { label: string; tone: 'ok' | 'wait' | 'you' | 'problem' };
  entries: TimelineEntry[];
}

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
  template: `
    @if (timeline(); as current) {
      <p class="order-waiting" [attr.data-tone]="current.waiting.tone">
        <span class="order-waiting-label">Stand</span> {{ current.waiting.label }}
      </p>
      <details class="run-step order-brief order-timeline">
        <summary>Zeitleiste ({{ current.entries.length }})</summary>
        <ol>
          @for (entry of current.entries; track $index) {
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
