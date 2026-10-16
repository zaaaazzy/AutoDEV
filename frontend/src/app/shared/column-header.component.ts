import { Component, ElementRef, computed, inject, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { SortDirection } from './table.js';

/** Tabellenkopf mit Sortier-Button und Filtermenü (Textfeld oder Mehrfachauswahl). */
@Component({
  selector: 'th[appColumnHeader]',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './column-header.component.html',
  host: { '[attr.aria-sort]': 'ariaSort()', '(document:click)': 'closeFilter($event)' },
})
export class ColumnHeaderComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly label = input.required<string>();
  readonly sortDir = input<SortDirection | null>(null);
  readonly filterActive = input(false);
  readonly textFilter = input(false);
  readonly textValue = input<string | undefined>(undefined);
  readonly options = input<string[]>([]);
  readonly selected = input<string[] | undefined>(undefined);
  readonly sortRequested = output<void>();
  readonly textChange = output<string>();
  readonly valueToggle = output<{ option: string; checked: boolean }>();

  protected readonly ariaSort = computed(() => {
    const dir = this.sortDir();
    return dir ? (dir === 'asc' ? 'ascending' : 'descending') : 'none';
  });
  protected readonly sortMark = computed(() => {
    const dir = this.sortDir();
    return dir ? (dir === 'asc' ? ' ▲' : ' ▼') : '';
  });

  protected closeFilter(event: Event): void {
    const filter = this.host.nativeElement.querySelector('.col-filter[open]');
    if (filter && !filter.contains(event.target as Node)) filter.removeAttribute('open');
  }

  protected toggle(option: string, event: Event): void {
    this.valueToggle.emit({ option, checked: (event.target as HTMLInputElement).checked });
  }
}
