import { NgClass } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import type { DevelopmentItem, Idea, Priority } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import type { FormValues } from '../../shared/forms.js';
import { ColumnHeaderComponent } from '../../shared/column-header.component.js';
import { DEVELOPMENT_STATUSES, priorityLabel, statusLabel } from '../../shared/labels.js';
import { formatHours } from '../../shared/format.js';
import { HoursPipe, PriorityLabelPipe, ShortTextPipe, StatusClassPipe, StatusLabelPipe } from '../../shared/pipes.js';
import { compareRanks, includesText, toggleListValue, toggleSort, type SortState } from '../../shared/table.js';
import { OrderDetailComponent } from './order-detail.component.js';
import { OrderService } from './order.service.js';

type DevKey = 'title' | 'description' | 'status' | 'priority' | 'sprint' | 'effortHours';
type DevTextKey = 'title' | 'description';
type DevValueKey = 'status' | 'priority' | 'sprint' | 'effortHours';

@Component({
  selector: 'app-development',
  standalone: true,
  imports: [
    NgClass,
    FormsModule,
    ColumnHeaderComponent,
    OrderDetailComponent,
    HoursPipe,
    PriorityLabelPipe,
    ShortTextPipe,
    StatusClassPipe,
    StatusLabelPipe,
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
  protected readonly devColumns: { key: DevKey; label: string }[] = [
    { key: 'title', label: 'Titel' },
    { key: 'status', label: 'Status' },
    { key: 'priority', label: 'Priorität' },
    { key: 'sprint', label: 'Sprint' },
    { key: 'effortHours', label: 'Aufwand' },
  ];

  protected developmentForm: { title: string; priority: Priority } = { title: '', priority: 'medium' };
  protected readonly devText = signal<Partial<Record<DevTextKey, string>>>({});
  protected readonly devValues = signal<Partial<Record<DevValueKey, string[]>>>({});
  protected readonly devSort = signal<SortState<DevKey>>({ key: 'priority', dir: 'desc' });
  protected readonly openOrder = signal<string | null>(null);
  protected readonly orderEditing = signal<string | null>(null);
  protected readonly showDoneOrders = signal(false);

  protected readonly doneOrders = computed(() => this.data().development.filter((item) => item.status === 'done'));
  protected readonly openOrders = computed(() => {
    const text = this.devText();
    const values = this.devValues();
    const { key, dir } = this.devSort();
    const rank = (item: DevelopmentItem): string | number | null => {
      switch (key) {
        case 'priority':
          return ['low', 'medium', 'high'].indexOf(item.priority);
        case 'effortHours':
          return item.effortHours ?? null;
        case 'status':
          return DEVELOPMENT_STATUSES.indexOf(item.status);
        case 'sprint':
          return this.devCell(item, 'sprint').toLowerCase();
        default:
          return (item[key] ?? '').toString().toLowerCase();
      }
    };
    return this.data()
      .development.filter((item) => item.status !== 'done')
      .filter(
        (item) =>
          (['title', 'description'] as const).every((field) => includesText(item[field], text[field])) &&
          (Object.keys(values) as DevValueKey[]).every(
            (field) => !values[field]?.length || values[field]!.includes(this.devCell(item, field)),
          ),
      )
      .sort((a, b) => compareRanks(rank(a), rank(b), dir));
  });

  protected devCell(item: DevelopmentItem, key: DevValueKey): string {
    switch (key) {
      case 'status':
        return statusLabel(item.status);
      case 'priority':
        return priorityLabel(item.priority);
      case 'sprint':
        return this.store.sprintOf(item)?.name ?? 'Kein Sprint';
      default:
        return formatHours(item.effortHours);
    }
  }

  protected devOptions(key: DevKey): string[] {
    if (this.isDevText(key)) return [];
    return [
      ...new Set(
        this.data()
          .development.filter((item) => item.status !== 'done')
          .map((item) => this.devCell(item, key)),
      ),
    ].sort();
  }

  protected isDevText(key: DevKey): key is DevTextKey {
    return key === 'title' || key === 'description';
  }

  protected devFilterActive(key: DevKey): boolean {
    return this.isDevText(key) ? !!this.devText()[key] : !!this.devValues()[key]?.length;
  }

  protected textValue(key: DevKey): string | undefined {
    return this.isDevText(key) ? this.devText()[key] : undefined;
  }

  protected selectedValues(key: DevKey): string[] | undefined {
    return this.isDevText(key) ? undefined : this.devValues()[key];
  }

  protected hasDevFilters(): boolean {
    return this.devColumns.some((col) => this.devFilterActive(col.key));
  }

  protected clearDevFilters(): void {
    this.devText.set({});
    this.devValues.set({});
  }

  protected setDevText(key: DevKey, value: string): void {
    if (!this.isDevText(key)) return;
    this.devText.update((filter) => ({ ...filter, [key]: value }));
  }

  protected toggleDevValue(key: DevKey, value: string, checked: boolean): void {
    if (this.isDevText(key)) return;
    this.devValues.update((filter) => ({ ...filter, [key]: toggleListValue(filter[key], value, checked) }));
  }

  protected sortDevBy(key: DevKey): void {
    this.devSort.update((sort) => toggleSort(sort, key));
  }

  protected toggleOrder(id: string): void {
    this.openOrder.set(this.openOrder() === id ? null : id);
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
      await this.api.post(`${this.api.projectPath(this.store.activeProject())}/development`, this.developmentForm);
      this.developmentForm = { title: '', priority: 'medium' };
      this.store.showCreate.set(false);
    }, 'Entwicklungsauftrag hinzugefügt.');
  }
}
