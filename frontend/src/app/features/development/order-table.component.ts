import { NgClass, NgTemplateOutlet } from '@angular/common';
import {
  Component,
  computed,
  contentChild,
  Directive,
  effect,
  inject,
  input,
  model,
  signal,
  TemplateRef,
  untracked,
} from '@angular/core';
import type { SortingState } from '@tanstack/angular-table';
import { AuthService } from '../../core/auth.service.js';
import type { DevelopmentItem } from '../../core/models.js';
import { FocusOnce } from '../../core/focus-once.js';
import { ProjectStore } from '../../core/project-store.js';
import { BulkBarComponent } from '../../shared/bulk-bar.component.js';
import { categoryColumn } from '../../shared/data-table/columns.js';
import {
  type DataColumn,
  DataActionsDirective,
  DataCellDirective,
  DataDetailDirective,
  DataTableComponent,
} from '../../shared/data-table/data-table.component.js';
import { formatHours } from '../../shared/format.js';
import type { FormValues } from '../../shared/forms.js';
import { DEVELOPMENT_STATUSES, orderTitle, priorityLabel, statusLabel } from '../../shared/labels.js';
import { StatusClassPipe, StatusLabelPipe } from '../../shared/pipes.js';
import { BugIconComponent } from '../../shared/bug-icon.component.js';
import { NO_AGENT, orderAgentName } from '../dashboard/order-shares.js';
import { bulkSelectable, canRetry } from './order-bulk.js';
import { OrderDetailComponent } from './order-detail.component.js';
import { OrderService } from './order.service.js';
import { defined } from '../../../../../src/core/defined.js';

const PRIORITY_RANK = ['low', 'medium', 'high'];

/** Zusätzliche Knöpfe je Zeile vor dem Bearbeiten-Stift: `<ng-template appOrderActions let-item>`. */
@Directive({ selector: 'ng-template[appOrderActions]', standalone: true })
export class OrderActionsDirective {
  readonly template = inject<TemplateRef<{ $implicit: DevelopmentItem }>>(TemplateRef);
}

/** Eigener Inhalt der aufgeklappten Zeile statt der Auftragsdetails: `<ng-template appOrderDetail let-item>`. */
@Directive({ selector: 'ng-template[appOrderDetail]', standalone: true })
export class OrderDetailSlotDirective {
  readonly template = inject<TemplateRef<{ $implicit: DevelopmentItem }>>(TemplateRef);
}

/**
 * Auftragsliste mit aufklappbarer Detail- und Agent-Ansicht. Dieselbe Komponente nutzen die Auftragsseite
 * und die Agents-Seite („Letzte Aufträge“) – eine Änderung gilt überall.
 */
@Component({
  selector: 'app-order-table',
  standalone: true,
  imports: [
    NgClass,
    NgTemplateOutlet,
    BugIconComponent,
    BulkBarComponent,
    DataTableComponent,
    DataCellDirective,
    DataActionsDirective,
    DataDetailDirective,
    OrderDetailComponent,
    StatusClassPipe,
    StatusLabelPipe,
  ],
  templateUrl: './order-table.component.html',
})
export class OrderTableComponent {
  private readonly orders = inject(OrderService);
  protected readonly store = inject(ProjectStore);
  protected readonly auth = inject(AuthService);
  /** Filter aus einem Dashboard-Link (z. B. Status „Blockiert“). */
  protected readonly linkFilters = computed(() => (this.linkFiltered() ? this.store.filtersFor('development') : {}));

  readonly items = input.required<DevelopmentItem[]>();
  readonly emptyText = input('Keine Aufträge.');
  readonly initialSort = input<SortingState>([{ id: 'priority', desc: true }]);
  /** Beim Aufklappen gleich die Agent-Ansicht öffnen (Agents-Seite). */
  readonly agentsOpen = input(false);
  /** Zwischenüberschriften je Wert dieser Spalte (z. B. Phase im Sprint). */
  readonly groupBy = input<string | null>(null);
  /** Spalten ersetzen (gleiche id) bzw. vorne ergänzen; `hiddenColumns` blendet Standardspalten aus. */
  readonly extraColumns = input<DataColumn<DevelopmentItem>[]>([]);
  readonly hiddenColumns = input<string[]>([]);
  /** false: keine Spalte sortierbar – für Listen, deren Reihenfolge selbst die Aussage ist (Abarbeitung im Sprint). */
  readonly sortable = input<boolean>(true);
  /** Mehrfachauswahl wie in der Datentabelle; ohne Funktion keine Häkchen. */
  readonly selectable = input<((item: DevelopmentItem) => boolean) | null>(null);
  readonly selection = model<ReadonlySet<string>>(new Set());
  /**
   * Sammelaktionen: Häkchen an offenen Aufträgen und darüber eine schmale Leiste („Erneut versuchen“, „Priorität“).
   * Ein eigenes `selectable` der einbettenden Ansicht hat Vorrang (dann ohne Leiste, z. B. „Aufträge hinzufügen“).
   */
  readonly bulk = input(false);
  /** false: kein Bearbeiten-Stift in der Zeile (z. B. unter „Aktionen“). */
  readonly editable = input(true);
  /** Filter aus Dashboard-Links (#development?status=…) anwenden; unter „Aktionen“ aus. */
  readonly linkFiltered = input(true);
  protected readonly extraActions = contentChild(OrderActionsDirective);
  protected readonly customDetail = contentChild(OrderDetailSlotDirective);

  protected readonly openOrder = signal<string | null>(null);

  protected readonly bulkActive = computed(() => this.bulk() && !this.selectable());
  protected readonly rowSelectable = computed(() => this.selectable() ?? (this.bulk() ? bulkSelectable : null));
  /** Gewählte Aufträge, die noch in der Liste stehen und wählbar sind (nach dem Nachladen fallen erledigte weg). */
  protected readonly picked = computed(() => {
    const ids = this.selection();
    return this.items().filter((item) => ids.has(item.id) && bulkSelectable(item));
  });
  protected readonly retryable = computed(() => this.picked().filter(canRetry));

  protected clearSelection(): void {
    this.selection.set(new Set());
  }

  protected async retryPicked(): Promise<void> {
    await this.orders.retryMany(this.retryable());
    this.clearSelection();
  }

  protected async setPriority(select: HTMLSelectElement): Promise<void> {
    const priority = select.value as DevelopmentItem['priority'];
    select.value = '';
    if (!priority) return;
    await this.orders.setPriorityMany(this.picked(), priority);
  }

  constructor() {
    // Link auf einen Auftrag (#development/<id>): Zeile aufklappen – einmal je Link, damit ein Nachladen im
    // Hintergrund eine von Hand zugeklappte Zeile nicht wieder öffnet.
    const focus = new FocusOnce();
    effect(() => {
      const id = this.store.focusId();
      if (focus.take(id, !!id && this.items().some((item) => item.id === id))) untracked(() => this.openOrder.set(id));
    });
  }
  protected readonly orderEditing = signal<string | null>(null);
  protected readonly orderId = (item: DevelopmentItem): string => item.id;
  private readonly baseColumns: DataColumn<DevelopmentItem>[] = [
    { id: 'title', header: 'Titel', value: (item) => item.title, filter: 'text', className: 'title-cell' },
    {
      id: 'status',
      header: 'Status',
      value: (item) => statusLabel(item.status),
      sortValue: (item) => DEVELOPMENT_STATUSES.indexOf(item.status),
    },
    {
      id: 'priority',
      header: 'Priorität',
      value: (item) => priorityLabel(item.priority),
      sortValue: (item) => PRIORITY_RANK.indexOf(item.priority),
    },
    categoryColumn<DevelopmentItem>((item) => item.category),
    { id: 'sprint', header: 'Sprint', value: (item) => this.store.sprintOf(item)?.name ?? 'Kein Sprint' },
    // Filterziel der Dashboard-Verteilung „Offene Aufträge je Agent“.
    { id: 'agent', header: 'Agent', value: (item) => orderAgentName(item, this.store.data().agents) },
    {
      id: 'effortHours',
      header: 'Aufwand (Agent-Std.)',
      value: (item) => formatHours(item.calibratedHours ?? item.effortHours),
      sortValue: (item) => item.calibratedHours ?? item.effortHours ?? -1,
    },
  ];
  protected readonly columns = computed(() => {
    const extra = this.extraColumns();
    const hidden = new Set(this.hiddenColumns());
    // „Agent“ nur zeigen, wenn mindestens ein Auftrag einen Agent hat (oder danach gefiltert wird);
    // sonst steht in jeder Zeile nur „Ohne Agent“.
    const agents = this.store.data().agents;
    const agentFiltered = Boolean(this.linkFilters()['agent']?.length);
    if (!agentFiltered && this.items().every((item) => orderAgentName(item, agents) === NO_AGENT)) hidden.add('agent');
    const replaced = new Set(extra.map((column) => column.id));
    const base = this.baseColumns
      .filter((column) => !hidden.has(column.id))
      .map((column) => (replaced.has(column.id) ? defined(extra.find((entry) => entry.id === column.id)) : column));
    const known = new Set(this.baseColumns.map((column) => column.id));
    const columns = [...extra.filter((column) => !known.has(column.id)), ...base];
    return this.sortable() ? columns : columns.map((column) => ({ ...column, sortable: false }));
  });
  protected readonly selectLabel = (item: DevelopmentItem): string => `Auswählen: ${this.displayTitle(item)}`;

  /** Bei Bugs ersetzt der Käfer das Präfix „Bug:“. */
  protected readonly displayTitle = orderTitle;

  protected toggleOrder(id: string): void {
    this.openOrder.set(this.openOrder() === id ? null : id);
  }

  /** Stift in der Liste: Zeile aufklappen und direkt bearbeiten. */
  protected editOrder(id: string): void {
    this.openOrder.set(id);
    this.orderEditing.set(this.orderEditing() === id ? null : id);
  }

  protected async saveOrder(item: DevelopmentItem, values: FormValues): Promise<void> {
    await this.orders.save(item, values);
    this.orderEditing.set(null);
  }
}
