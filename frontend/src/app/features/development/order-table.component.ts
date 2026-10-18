import { NgClass } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
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

/** Blockiert, aber nur ein Mensch kann weiterhelfen: „Aktion notwendig“ statt „Blockiert“. */
export function orderStatusLabel(item: DevelopmentItem): string {
  return item.actionTodo && item.status === 'blocked' ? 'Aktion notwendig' : statusLabel(item.status);
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
  protected readonly linkFilters = computed(() => this.store.filtersFor('development'));

  readonly items = input.required<DevelopmentItem[]>();
  readonly emptyText = input('Keine Aufträge.');
  readonly initialSort = input<SortingState>([{ id: 'priority', desc: true }]);
  /** Beim Aufklappen gleich die Agent-Ansicht öffnen (Agents-Seite). */
  readonly agentsOpen = input(false);

  protected readonly openOrder = signal<string | null>(null);
  protected readonly statusText = orderStatusLabel;

  constructor() {
    // Link auf einen Auftrag (#development/<id>): Zeile aufklappen.
    effect(() => {
      const id = this.store.focusId();
      if (id && this.items().some((item) => item.id === id)) untracked(() => this.openOrder.set(id));
    });
  }
  protected readonly orderEditing = signal<string | null>(null);
  protected readonly orderId = (item: DevelopmentItem): string => item.id;
  protected readonly columns: DataColumn<DevelopmentItem>[] = [
    { id: 'title', header: 'Titel', value: (item) => item.title, filter: 'text', className: 'title-cell' },
    {
      id: 'status',
      header: 'Status',
      value: (item) => orderStatusLabel(item),
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
