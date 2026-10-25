import { Component, computed, inject, input, signal } from '@angular/core';
import { BulkBarComponent } from '../../shared/bulk-bar.component.js';
import type { SortingState } from '@tanstack/angular-table';
import { ApiService } from '../../core/api.service.js';
import { AuthService } from '../../core/auth.service.js';
import type { DevelopmentItem, Sprint } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import type { DataColumn } from '../../shared/data-table/data-table.component.js';
import { canTakeIntoSprint, isAssignableSprintStatus } from '../../../../../src/core/development-transitions.js';
import { OrderActionsDirective, OrderTableComponent } from '../development/order-table.component.js';
import { pickInOrder, poolOpenState } from './pool-selection.js';
import { byRank, moveId, orderSprint, phaseLabel, phaseRank, sprintPhase } from './sprint-phases.js';

/**
 * Aufträge eines Sprints als Liste wie auf der Auftragsseite, nach Phase eingeordnet. „Geplant“ ist die
 * Reihenfolge, in der die Agents abarbeiten (↑/↓); darunter lassen sich offene und abgebrochene Aufträge
 * in den Sprint nehmen. In Arbeit, Freigabe, Erledigt und Abgelehnt zeigen den Stand – dort bewegen die Agents.
 */
@Component({
  selector: 'app-sprint-orders',
  standalone: true,
  imports: [OrderTableComponent, OrderActionsDirective, BulkBarComponent],
  templateUrl: './sprint-orders.component.html',
})
export class SprintOrdersComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  private readonly auth = inject(AuthService);
  readonly sprint = input.required<Sprint>();

  protected readonly orders = computed(() =>
    orderSprint(this.store.data().development.filter((item) => item.sprintId === this.sprint().id)),
  );
  private readonly planned = computed(() => this.orders().filter((item) => sprintPhase(item) === 'planned'));
  private readonly position = computed(() => new Map(this.orders().map((item, index) => [item.id, index])));
  private readonly plannedRank = computed(() => new Map(this.planned().map((item, index) => [item.id, index + 1])));

  protected readonly sort: SortingState = [{ id: 'rank', desc: false }];
  protected readonly columns: DataColumn<DevelopmentItem>[] = [
    {
      id: 'rank',
      header: '#',
      value: (item) => this.plannedRank().get(item.id) ?? '',
      sortValue: (item) => this.position().get(item.id) ?? 1e9,
      filter: false,
      className: 'rank-cell',
    },
    // Ersetzt die Status-Spalte für Gruppen und Filter; die Zelle zeigt weiterhin den genauen Status.
    {
      id: 'status',
      header: 'Status',
      value: (item) => phaseLabel(sprintPhase(item)),
      sortValue: (item) => phaseRank(sprintPhase(item)),
    },
  ];

  /**
   * Zur Auswahl: offene (noch in keinem Sprint) und abgebrochene (aus einem Sprint genommen oder gescheitert) – dieselbe
   * Regel wie die Route take-into-sprint. Laufende oder in Freigabe stehen nicht zur Wahl (sonst 409).
   */
  protected readonly free = computed(() => {
    const free = this.store.data().development.filter(canTakeIntoSprint);
    const aborted = (item: DevelopmentItem): boolean => !!item.removedFromSprintAt || item.status === 'blocked';
    return [...byRank(free.filter((item) => !aborted(item))), ...byRank(free.filter(aborted))];
  });
  protected readonly poolColumns: DataColumn<DevelopmentItem>[] = [
    {
      id: 'sprint',
      header: 'Herkunft',
      value: (item) =>
        item.removedFromSprintAt || item.status === 'blocked' ? 'Abgebrochen' : 'Offen – noch in keinem Sprint',
      sortValue: (item) => (item.removedFromSprintAt || item.status === 'blocked' ? 1 : 0),
    },
  ];
  protected readonly anyRow = (): boolean => true;
  /**
   * „Aufträge hinzufügen“ ist bei leerem Sprint offen, sonst zu; eine von Hand geöffnete Liste bleibt beim Nachladen
   * offen (siehe poolOpenState). Die Liste wird nur gerendert, wenn sie offen ist:
   * In einem zugeklappten <details> hätte sie eine Höhe, wäre aber nicht fokussierbar (Chrome rendert den Inhalt
   * mit content-visibility) – Filter und Prüfungen hielten sie für sichtbar.
   */
  protected readonly poolOpen = poolOpenState(() => this.orders());
  protected readonly selectedIds = signal<ReadonlySet<string>>(new Set());
  /** Nur, was noch zur Auswahl steht (inzwischen eingeplante fallen weg), in Anzeige-Reihenfolge. */
  protected readonly selection = computed(() => pickInOrder(this.free(), this.selectedIds()));

  protected readonly editable = computed(
    () => !['completed', 'cancelled'].includes(this.sprint().status) && this.auth.can('plan'),
  );
  /** Hineinnehmen nur in geplante oder aktive Sprints (dieselbe Regel wie der Server); im Review und danach nicht. */
  protected readonly canTakeIn = computed(() => this.editable() && isAssignableSprintStatus(this.sprint().status));

  protected clearSelection(): void {
    this.selectedIds.set(new Set());
  }

  protected isPlanned(item: DevelopmentItem): boolean {
    return sprintPhase(item) === 'planned';
  }

  protected canMove(item: DevelopmentItem, delta: number): boolean {
    const ids = this.planned().map((entry) => entry.id);
    const to = ids.indexOf(item.id) + delta;
    return to >= 0 && to < ids.length;
  }

  protected title(item: DevelopmentItem): string {
    return item.kind === 'bug' ? item.title.replace(/^Bug:\s*/i, '') : item.title;
  }

  /** Reihenfolge der geplanten Aufträge ändern; die Agents arbeiten sie von oben nach unten ab. */
  protected async move(item: DevelopmentItem, delta: number): Promise<void> {
    const ids = moveId(
      this.planned().map((entry) => entry.id),
      item.id,
      delta,
    );
    await this.store.perform(
      () => this.api.post(`/api/sprints/${encodeURIComponent(this.sprint().id)}/order`, { ids }),
      'Reihenfolge gespeichert.',
    );
  }

  protected async take(item: DevelopmentItem): Promise<void> {
    await this.store.perform(() => this.takeIntoSprint(item), `„${this.title(item)}“ ist im Sprint.`);
  }

  /** Herausgenommene gelten als abgebrochen: unten zur Auswahl und unter „Aktionen“. */
  protected async remove(item: DevelopmentItem): Promise<void> {
    await this.store.perform(
      () => this.api.post(`/api/development/${encodeURIComponent(item.id)}/remove-from-sprint`),
      `„${this.title(item)}“ ist aus dem Sprint genommen.`,
    );
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

  /**
   * Offene kommen direkt in den Sprint; abgebrochene werden dabei neu eingeplant (Fehler und Vermerk zurückgesetzt).
   * Eine Server-Route statt /retry + PATCH: /retry hängte den Auftrag erst an den aktiven Sprint und setzte auto_run,
   * sodass er auch in einem noch geplanten Sprint sofort startete.
   */
  private async takeIntoSprint(item: DevelopmentItem): Promise<void> {
    if (!this.canTakeIn()) throw new Error('Aufträge lassen sich nur geplanten oder aktiven Sprints zuordnen.');
    await this.api.post(`/api/development/${encodeURIComponent(item.id)}/take-into-sprint`, {
      sprintId: this.sprint().id,
    });
  }
}
