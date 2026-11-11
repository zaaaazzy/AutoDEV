import { Component, computed, inject, input } from '@angular/core';
import type { DevelopmentItem, Sprint } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import type { DataColumn } from '../../shared/data-table/data-table.component.js';
import { OrderTableComponent } from '../development/order-table.component.js';
import { requestState, sprintRequests } from './sprint-requests.js';

/**
 * Register „Anfragen“ im Sprint: Umsetzungen, die auf die Freigabe warten. Ein Klick auf eine Zeile führt zu ihr auf
 * die Seite „Aktionen“ – dort stehen Vorschau, Abnahme und Zurückweisen.
 */
@Component({
  selector: 'app-sprint-requests',
  standalone: true,
  imports: [OrderTableComponent],
  template: `
    <app-order-table
      class="sprint-requests"
      [items]="requests()"
      [extraColumns]="columns"
      [hiddenColumns]="['sprint', 'priority']"
      [initialSort]="[]"
      [sortable]="false"
      [editable]="false"
      [linkFiltered]="false"
      [rowOpen]="open"
      emptyText="Keine Umsetzung wartet auf die Freigabe."
    />
  `,
})
export class SprintRequestsComponent {
  private readonly store = inject(ProjectStore);
  readonly sprint = input.required<Sprint>();

  protected readonly requests = computed(() => sprintRequests(this.store.data().development, this.sprint().id));
  protected readonly columns: DataColumn<DevelopmentItem>[] = [
    { id: 'request', header: 'Abnahme', value: requestState },
  ];

  protected readonly open = (item: DevelopmentItem): void => this.store.navigate('actions', { focus: item.id });
}
