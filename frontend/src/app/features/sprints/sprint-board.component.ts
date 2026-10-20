import {
  CdkDrag,
  type CdkDragDrop,
  CdkDragPlaceholder,
  CdkDropList,
  CdkDropListGroup,
  moveItemInArray,
} from '@angular/cdk/drag-drop';
import { Component, computed, inject, input, signal } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import { AuthService } from '../../core/auth.service.js';
import type { DevelopmentItem, Sprint } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { BugIconComponent } from '../../shared/bug-icon.component.js';
import { formatHours } from '../../shared/format.js';
import { categoryLabel, isFinished, priorityLabel, statusLabel } from '../../shared/labels.js';
import { isAssignableSprintStatus } from '../../../../../src/core/development-transitions.js';
import { groupState, pickInOrder, toggleGroup, toggleId } from './pool-selection.js';

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
  protected readonly store = inject(ProjectStore);
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

  /** Mehrfachauswahl unter dem Board: angehakte Aufträge auf einmal in den Sprint nehmen. */
  private readonly selectedIds = signal<ReadonlySet<string>>(new Set());
  /** Nur, was noch zur Auswahl steht (inzwischen eingeplante fallen weg), in Anzeige-Reihenfolge. */
  protected readonly selection = computed(() =>
    pickInOrder([...this.columns().open, ...this.columns().aborted], this.selectedIds()),
  );
  protected readonly selectedSet = computed(() => new Set(this.selection().map((item) => item.id)));

  protected toggleSelected(item: DevelopmentItem): void {
    this.selectedIds.set(toggleId(this.selectedSet(), item.id));
  }

  protected toggleAll(items: DevelopmentItem[]): void {
    this.selectedIds.set(
      toggleGroup(
        this.selectedSet(),
        items.map((item) => item.id),
      ),
    );
  }

  protected allState(items: DevelopmentItem[]): 'none' | 'some' | 'all' {
    return groupState(
      this.selectedSet(),
      items.map((item) => item.id),
    );
  }

  protected clearSelection(): void {
    this.selectedIds.set(new Set());
  }

  /** Alle angehakten nacheinander in den Sprint; scheitert einer, laufen die übrigen weiter. */
  protected async takeSelected(): Promise<void> {
    const items = this.selection();
    if (!items.length) return;
    const failed: string[] = [];
    await this.store.perform(
      async () => {
        for (const item of items) {
          await this.takeIntoSprint(item).catch(() => failed.push(this.title(item)));
        }
        this.clearSelection();
      },
      `${items.length} ${items.length === 1 ? 'Auftrag ist' : 'Aufträge sind'} im Sprint.`,
    );
    // Nachgeladen wird trotzdem; die Meldung nennt, was nicht übernommen wurde.
    if (failed.length) {
      this.store.notice.set(
        `${items.length - failed.length} von ${items.length} im Sprint – nicht übernommen: ${failed.join(', ')}.`,
      );
    }
  }

  protected readonly editable = computed(() => this.sprint().status !== 'completed' && this.auth.can('plan'));
  /** Hineinnehmen nur in geplante oder aktive Sprints (dieselbe Regel wie der Server); im Review und danach nicht. */
  protected readonly canTakeIn = computed(() => this.editable() && isAssignableSprintStatus(this.sprint().status));

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

  /** Herausgenommene gelten als abgebrochen: unter dem Board und unter „Aktionen“. */
  private takeOutOfSprint(item: DevelopmentItem): Promise<unknown> {
    return this.api.post(`/api/development/${encodeURIComponent(item.id)}/remove-from-sprint`);
  }

  /** Offene kommen direkt in den Sprint; abgebrochene werden dabei neu eingeplant (Fehler und Vermerk zurückgesetzt). */
  private async takeIntoSprint(item: DevelopmentItem): Promise<void> {
    // Erst prüfen, dann /retry: sonst wäre ein abgebrochener Auftrag neu eingeplant, aber in keinem Sprint.
    if (!this.canTakeIn()) throw new Error('Aufträge lassen sich nur geplanten oder aktiven Sprints zuordnen.');
    if (item.removedFromSprintAt || item.status === 'blocked') {
      await this.api.post(`/api/development/${encodeURIComponent(item.id)}/retry`);
    }
    await this.api.patch(`/api/development/${encodeURIComponent(item.id)}`, { sprintId: this.sprint().id });
  }
}
