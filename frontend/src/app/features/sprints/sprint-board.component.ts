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
import { categoryLabel, isFinished, priorityLabel, statusLabel } from '../../shared/labels.js';

const PRIORITY = { high: 0, medium: 1, low: 2 } as const;

/**
 * Kanban eines Sprints: offene Aufträge in den Sprint ziehen, Reihenfolge per Ziehen festlegen (die Agents arbeiten
 * sie von oben nach unten ab). In Arbeit, Blockiert, Erledigt und Abgelehnt zeigen den Stand – dort bewegen die Agents.
 * Jeder Titel verlinkt auf den Auftrag (#development/<id>).
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
    const free = items.filter((item) => !item.sprintId && !isFinished(item.status) && item.status !== 'in_progress');
    return {
      // Unter dem Board zur Auswahl: offene (noch in keinem Sprint) und abgebrochene (aus einem Sprint genommen
      // oder ohne Sprint gescheitert) – per Ziehen oder → in den Sprint holen.
      open: this.byRank(free.filter((item) => !item.removedFromSprintAt && item.status !== 'blocked')),
      aborted: this.byRank(free.filter((item) => item.removedFromSprintAt || item.status === 'blocked')),
      planned: this.byRank(mine.filter((item) => item.status === 'planned' || item.status === 'backlog')),
      running: mine.filter((item) => item.status === 'in_progress'),
      blocked: mine.filter((item) => item.status === 'blocked'),
      approval: mine.filter((item) => item.status === 'approval'),
      done: mine.filter((item) => item.status === 'done'),
      rejected: mine.filter((item) => item.status === 'rejected'),
    };
  });

  protected readonly lanes = computed(() => {
    const board = this.columns();
    return [
      { id: 'planned', title: 'Geplant', hint: 'Reihenfolge = Abarbeitung', items: board.planned, drop: true },
      { id: 'running', title: 'In Arbeit', hint: '', items: board.running, drop: false },
      { id: 'blocked', title: statusLabel('blocked'), hint: '', items: board.blocked, drop: false },
      {
        id: 'approval',
        title: statusLabel('approval'),
        hint: 'ansehen und freigeben',
        items: board.approval,
        drop: false,
      },
      { id: 'done', title: 'Erledigt', hint: '', items: board.done, drop: false },
      { id: 'rejected', title: 'Abgelehnt', hint: 'verstösst gegen Projektregel', items: board.rejected, drop: false },
    ];
  });

  /** Auswahl unter dem Board (nur solange der Sprint nicht abgeschlossen ist). */
  protected readonly pools = computed(() => {
    const board = this.columns();
    return [
      { id: 'open', title: 'Offen', hint: 'noch in keinem Sprint', items: board.open },
      { id: 'aborted', title: 'Abgebrochen', hint: 'aus einem Sprint genommen oder gescheitert', items: board.aborted },
    ];
  });

  protected readonly editable = computed(() => this.sprint().status !== 'completed' && this.auth.can('plan'));

  protected link(item: DevelopmentItem): string {
    return `#development/${item.id}`;
  }

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
          await this.takeIntoSprint(item);
        } else if (!toPlanned && fromPlanned) {
          await this.takeOutOfSprint(item);
          return;
        }
        await this.api.post(`/api/sprints/${encodeURIComponent(sprintId)}/order`, {
          ids: planned.map((entry) => entry.id),
        });
      },
      toPlanned && !fromPlanned
        ? `„${this.title(item)}“ ist im Sprint.`
        : !toPlanned
          ? `„${this.title(item)}“ ist aus dem Sprint genommen.`
          : 'Reihenfolge gespeichert.',
    );
  }

  /** Ohne Ziehen (z. B. Tastatur): Auftrag in den Sprint nehmen bzw. herausnehmen. */
  protected async move(item: DevelopmentItem, intoSprint: boolean): Promise<void> {
    await this.store.perform(
      () => (intoSprint ? this.takeIntoSprint(item) : this.takeOutOfSprint(item)),
      intoSprint ? `„${this.title(item)}“ ist im Sprint.` : `„${this.title(item)}“ ist aus dem Sprint genommen.`,
    );
  }

  /** Herausgenommene gelten als abgebrochen: unter dem Board und unter „Besondere Aufmerksamkeit“. */
  private takeOutOfSprint(item: DevelopmentItem): Promise<unknown> {
    return this.api.post(`/api/development/${encodeURIComponent(item.id)}/remove-from-sprint`);
  }

  /** Offene kommen direkt in den Sprint; abgebrochene werden dabei neu eingeplant (Fehler und Vermerk zurückgesetzt). */
  private async takeIntoSprint(item: DevelopmentItem): Promise<void> {
    if (item.removedFromSprintAt || item.status === 'blocked') {
      await this.api.post(`/api/development/${encodeURIComponent(item.id)}/retry`);
    }
    await this.api.patch(`/api/development/${encodeURIComponent(item.id)}`, { sprintId: this.sprint().id });
  }
}
