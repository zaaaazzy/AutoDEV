import {
  CdkDrag,
  type CdkDragDrop,
  CdkDragPlaceholder,
  CdkDropList,
  CdkDropListGroup,
  moveItemInArray,
} from '@angular/cdk/drag-drop';
import { Component, computed, inject, input } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import { AuthService } from '../../core/auth.service.js';
import type { DevelopmentItem, Sprint } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { BugIconComponent } from '../../shared/bug-icon.component.js';
import { formatHours } from '../../shared/format.js';
import { categoryLabel, priorityLabel } from '../../shared/labels.js';

const PRIORITY = { high: 0, medium: 1, low: 2 } as const;

/**
 * Kanban eines Sprints: offene Aufträge in den Sprint ziehen, Reihenfolge per Ziehen festlegen (die Agents arbeiten
 * sie von oben nach unten ab). In Arbeit, Blockiert und Erledigt zeigen den Stand – dort bewegen die Agents.
 */
@Component({
  selector: 'app-sprint-board',
  standalone: true,
  imports: [CdkDropListGroup, CdkDropList, CdkDrag, CdkDragPlaceholder, BugIconComponent],
  templateUrl: './sprint-board.component.html',
})
export class SprintBoardComponent {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);
  protected readonly auth = inject(AuthService);
  readonly sprint = input.required<Sprint>();

  protected readonly formatHours = formatHours;
  protected readonly priorityLabel = priorityLabel;
  protected readonly categoryLabel = categoryLabel;

  private byRank(items: DevelopmentItem[]): DevelopmentItem[] {
    return [...items].sort(
      (a, b) => (a.sprintRank ?? 1e9) - (b.sprintRank ?? 1e9) || PRIORITY[a.priority] - PRIORITY[b.priority],
    );
  }

  protected readonly columns = computed(() => {
    const items = this.store.data().development;
    const id = this.sprint().id;
    const mine = items.filter((item) => item.sprintId === id);
    return {
      open: this.byRank(
        items.filter((item) => !item.sprintId && (item.status === 'backlog' || item.status === 'planned')),
      ),
      planned: this.byRank(mine.filter((item) => item.status === 'planned' || item.status === 'backlog')),
      running: mine.filter((item) => item.status === 'in_progress'),
      blocked: mine.filter((item) => item.status === 'blocked'),
      done: mine.filter((item) => item.status === 'done'),
    };
  });

  protected readonly lanes = computed(() => {
    const board = this.columns();
    return [
      { id: 'open', title: 'Offen', hint: 'nicht im Sprint', items: board.open, drop: true },
      { id: 'planned', title: 'Geplant', hint: 'Reihenfolge = Abarbeitung', items: board.planned, drop: true },
      { id: 'running', title: 'In Arbeit', hint: '', items: board.running, drop: false },
      { id: 'blocked', title: 'Blockiert', hint: '', items: board.blocked, drop: false },
      { id: 'done', title: 'Erledigt', hint: '', items: board.done, drop: false },
    ];
  });

  protected readonly editable = computed(() => this.sprint().status !== 'completed' && this.auth.can('plan'));

  protected title(item: DevelopmentItem): string {
    return item.kind === 'bug' ? item.title.replace(/^Bug:\s*/i, '') : item.title;
  }

  /** Ziehen: zwischen „Offen“ und „Geplant“ wechseln oder innerhalb „Geplant“ umsortieren. */
  protected async drop(event: CdkDragDrop<DevelopmentItem[], DevelopmentItem[], DevelopmentItem>): Promise<void> {
    const item = event.item.data;
    const toPlanned = event.container.id.endsWith('planned');
    const fromPlanned = event.previousContainer.id.endsWith('planned');
    if (event.previousContainer === event.container && !toPlanned) return;
    const planned = [...this.columns().planned];
    if (toPlanned && fromPlanned) {
      moveItemInArray(planned, event.previousIndex, event.currentIndex);
    } else if (toPlanned) {
      planned.splice(event.currentIndex, 0, item);
    }
    const sprintId = this.sprint().id;
    await this.store.perform(
      async () => {
        if (toPlanned && !fromPlanned) {
          await this.api.patch(`/api/development/${encodeURIComponent(item.id)}`, { sprintId });
        } else if (!toPlanned && fromPlanned) {
          await this.api.patch(`/api/development/${encodeURIComponent(item.id)}`, { sprintId: null });
          return;
        }
        await this.api.post(`/api/sprints/${encodeURIComponent(sprintId)}/order`, {
          ids: planned.map((entry) => entry.id),
        });
      },
      toPlanned && !fromPlanned
        ? `„${this.title(item)}“ ist im Sprint.`
        : !toPlanned
          ? `„${this.title(item)}“ ist wieder offen.`
          : 'Reihenfolge gespeichert.',
    );
  }

  /** Ohne Ziehen (z. B. Tastatur): Auftrag in den Sprint nehmen bzw. herausnehmen. */
  protected async move(item: DevelopmentItem, intoSprint: boolean): Promise<void> {
    await this.store.perform(
      () =>
        this.api.patch(`/api/development/${encodeURIComponent(item.id)}`, {
          sprintId: intoSprint ? this.sprint().id : null,
        }),
      intoSprint ? `„${this.title(item)}“ ist im Sprint.` : `„${this.title(item)}“ ist wieder offen.`,
    );
  }
}
