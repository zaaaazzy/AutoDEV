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
import type { DevelopmentItem } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
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
import { DEVELOPMENT_STATUSES, priorityLabel, statusLabel } from '../../shared/labels.js';
import { StatusClassPipe, StatusLabelPipe } from '../../shared/pipes.js';
import { BugIconComponent } from '../../shared/bug-icon.component.js';
import { OrderDetailComponent } from './order-detail.component.js';
import { OrderService } from './order.service.js';

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
  private readonly store = inject(ProjectStore);
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
  /** false: kein Bearbeiten-Stift in der Zeile (z. B. unter „Aktionen“). */
  readonly editable = input(true);
  /** Filter aus Dashboard-Links (#development?status=…) anwenden; unter „Aktionen“ aus. */
  readonly linkFiltered = input(true);
  protected readonly extraActions = contentChild(OrderActionsDirective);
  protected readonly customDetail = contentChild(OrderDetailSlotDirective);

  protected readonly openOrder = signal<string | null>(null);

  constructor() {
    // Link auf einen Auftrag (#development/<id>): Zeile aufklappen.
    effect(() => {
      const id = this.store.focusId();
      if (id && this.items().some((item) => item.id === id)) untracked(() => this.openOrder.set(id));
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
    {
      id: 'effortHours',
      header: 'Aufwand',
      value: (item) => formatHours(item.effortHours),
      sortValue: (item) => item.effortHours ?? -1,
    },
  ];
  protected readonly columns = computed(() => {
    const extra = this.extraColumns();
    const hidden = new Set(this.hiddenColumns());
    const replaced = new Set(extra.map((column) => column.id));
    const base = this.baseColumns
      .filter((column) => !hidden.has(column.id))
      .map((column) => (replaced.has(column.id) ? extra.find((entry) => entry.id === column.id)! : column));
    const known = new Set(this.baseColumns.map((column) => column.id));
    const columns = [...extra.filter((column) => !known.has(column.id)), ...base];
    return this.sortable() ? columns : columns.map((column) => ({ ...column, sortable: false }));
  });
  protected readonly selectLabel = (item: DevelopmentItem): string => `Auswählen: ${this.displayTitle(item)}`;

  /** Bei Bugs ersetzt der Käfer das Präfix „Bug:“. */
  protected displayTitle(item: DevelopmentItem): string {
    return item.kind === 'bug' ? item.title.replace(/^Bug:\s*/i, '') : item.title;
  }

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
