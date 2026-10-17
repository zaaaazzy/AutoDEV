import { NgClass, NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import type { DevelopmentItem, Idea, Priority } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import type { FormValues } from '../../shared/forms.js';
import { categoryColumn } from '../../shared/data-table/columns.js';
import {
  type DataColumn,
  DataActionsDirective,
  DataCellDirective,
  DataDetailDirective,
  DataTableComponent,
} from '../../shared/data-table/data-table.component.js';
import { CATEGORIES, DEVELOPMENT_STATUSES, priorityLabel, statusLabel } from '../../shared/labels.js';
import { formatHours } from '../../shared/format.js';
import { CategoryLabelPipe, ShortTextPipe, StatusClassPipe, StatusLabelPipe } from '../../shared/pipes.js';
import { OrderDetailComponent } from './order-detail.component.js';
import { OrderService } from './order.service.js';

const PRIORITY_RANK = ['low', 'medium', 'high'];

@Component({
  selector: 'app-development',
  standalone: true,
  imports: [
    NgClass,
    NgTemplateOutlet,
    FormsModule,
    DataTableComponent,
    DataCellDirective,
    DataDetailDirective,
    DataActionsDirective,
    OrderDetailComponent,
    ShortTextPipe,
    StatusClassPipe,
    StatusLabelPipe,
    CategoryLabelPipe,
  ],
  templateUrl: './development.component.html',
  host: { style: 'display: contents' },
})
export class DevelopmentComponent {
  private readonly api = inject(ApiService);
  private readonly orders = inject(OrderService);
  protected readonly store = inject(ProjectStore);
  protected readonly data = this.store.data;
  protected readonly busy = this.store.busy;
  protected readonly developmentStatuses = DEVELOPMENT_STATUSES;
  protected readonly orderId = (item: DevelopmentItem): string => item.id;
  protected readonly devColumns: DataColumn<DevelopmentItem>[] = [
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

  protected developmentForm: { title: string; priority: Priority; category: string } = {
    title: '',
    priority: 'medium',
    category: '',
  };
  protected readonly categories = CATEGORIES;
  protected readonly openOrder = signal<string | null>(null);
  protected readonly orderEditing = signal<string | null>(null);
  protected readonly showDoneOrders = signal(false);

  protected readonly doneOrders = computed(() => this.data().development.filter((item) => item.status === 'done'));
  protected readonly openOrders = computed(() => this.data().development.filter((item) => item.status !== 'done'));

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

  protected ideaOf(item: DevelopmentItem): Idea | null {
    return item.ideationId ? (this.data().ideas.find((idea) => idea.id === item.ideationId) ?? null) : null;
  }

  protected updateDevelopment(id: string, values: Partial<DevelopmentItem>): Promise<void> {
    return this.orders.update(id, values);
  }

  protected async createDevelopment(): Promise<void> {
    await this.store.perform(async () => {
      await this.api.post(`${this.api.projectPath(this.store.activeProject())}/development`, {
        ...this.developmentForm,
        category: this.developmentForm.category || null,
      });
      this.developmentForm = { title: '', priority: 'medium', category: '' };
      this.store.showCreate.set(false);
    }, 'Entwicklungsauftrag hinzugefügt.');
  }
}
