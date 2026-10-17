import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  computed,
  contentChild,
  contentChildren,
  Directive,
  ElementRef,
  HostListener,
  inject,
  input,
  model,
  signal,
  TemplateRef,
} from '@angular/core';
import {
  type ColumnDef,
  type ColumnFiltersState,
  createAngularTable,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getSortedRowModel,
  type SortingState,
  type Updater,
} from '@tanstack/angular-table';

export interface DataColumn<T> {
  id: string;
  header: string;
  /** Anzeige-, Such- und Filterwert der Zelle. */
  value: (row: T) => string | number | null | undefined;
  /** Eigener Sortierwert (z. B. Rang eines Status), sonst wird `value` sortiert. */
  sortValue?: (row: T) => string | number | null | undefined;
  /** select = Mehrfachauswahl der vorhandenen Werte, text = Freitext, false = kein Filter. */
  filter?: 'select' | 'text' | false;
  sortable?: boolean;
  /** CSS-Klasse für Kopf und Zellen, z. B. `title-cell`. */
  className?: string;
  /** Wert als farbiges Etikett darstellen; liefert die CSS-Klasse des Etiketts. */
  badge?: (row: T) => string;
}

/** Eigene Darstellung einer Spalte: `<ng-template appDataCell="status" let-row>`. */
@Directive({ selector: 'ng-template[appDataCell]', standalone: true })
export class DataCellDirective {
  readonly appDataCell = input.required<string>();
  readonly template = inject<TemplateRef<{ $implicit: unknown }>>(TemplateRef);
}

/** Inhalt der aufgeklappten Zeile: `<ng-template appDataDetail let-row>`. */
@Directive({ selector: 'ng-template[appDataDetail]', standalone: true })
export class DataDetailDirective {
  readonly template = inject<TemplateRef<{ $implicit: unknown }>>(TemplateRef);
}

/** Zusätzliche Knöpfe links vom Aufklapp-Pfeil: `<ng-template appDataActions let-row>`. */
@Directive({ selector: 'ng-template[appDataActions]', standalone: true })
export class DataActionsDirective {
  readonly template = inject<TemplateRef<{ $implicit: unknown }>>(TemplateRef);
}

const apply = <S>(updater: Updater<S>, old: S): S =>
  typeof updater === 'function' ? (updater as (value: S) => S)(old) : updater;

/**
 * Einheitliche Tabelle für alle Listen: Sortieren, Spaltenfilter, Suche (TanStack Table) und
 * aufklappbare Zeilen, deren Inhalt die einbettende Ansicht liefert.
 */
@Component({
  selector: 'app-data-table',
  standalone: true,
  imports: [NgTemplateOutlet],
  templateUrl: './data-table.component.html',
})
export class DataTableComponent<T> {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly rows = input.required<T[]>();
  readonly columns = input.required<DataColumn<T>[]>();
  readonly rowId = input.required<(row: T) => string>();
  readonly searchable = input(true);
  readonly emptyText = input('Keine Einträge.');
  readonly initialSort = input<SortingState>([]);
  /** Vorbelegte Filter je Spalte (Werte wie angezeigt). */
  readonly initialFilters = input<Record<string, string[]>>({});
  /** Zeilen nach dieser Spalte gruppieren (Zwischenüberschrift je Wert, Reihenfolge nach deren Sortierwert). */
  readonly groupBy = input<string | null>(null);
  /** Geöffnete Zeile; mit [(expanded)] von außen steuerbar. */
  readonly expanded = model<string | null>(null);

  private readonly cellTemplates = contentChildren(DataCellDirective);
  protected readonly detail = contentChild(DataDetailDirective);
  protected readonly actions = contentChild(DataActionsDirective);

  protected readonly search = signal('');
  protected readonly sorting = signal<SortingState | null>(null);
  protected readonly filters = signal<ColumnFiltersState | null>(null);
  protected readonly openFilter = signal<string | null>(null);
  /** Feste Position des Filtermenüs, damit der scrollbare Tabellenrahmen es nicht abschneidet. */
  protected readonly menuPosition = signal({ top: 0, left: 0 });

  private readonly effectiveSorting = computed(() => this.sorting() ?? this.initialSort());
  private readonly effectiveFilters = computed(
    () =>
      this.filters() ??
      Object.entries(this.initialFilters())
        .filter(([, values]) => values.length)
        .map(([id, value]) => ({ id, value })),
  );

  private readonly columnDefs = computed<ColumnDef<T>[]>(() =>
    this.columns().map((column) => ({
      id: column.id,
      header: column.header,
      accessorFn: (row: T) => column.value(row) ?? '',
      enableSorting: column.sortable !== false,
      enableColumnFilter: column.filter !== false,
      sortingFn: (left, right) => {
        const rank = column.sortValue ?? column.value;
        const a = rank(left.original) ?? '';
        const b = rank(right.original) ?? '';
        if (typeof a === 'number' && typeof b === 'number') return a - b;
        return String(a).localeCompare(String(b), 'de', { numeric: true, sensitivity: 'base' });
      },
      filterFn:
        column.filter === 'text'
          ? 'includesString'
          : (row, id, wanted: string[]) => !wanted?.length || wanted.includes(String(row.getValue(id))),
    })),
  );

  protected readonly table = createAngularTable<T>(() => ({
    data: this.rows(),
    columns: this.columnDefs(),
    state: {
      sorting: this.effectiveSorting(),
      columnFilters: this.effectiveFilters(),
      globalFilter: this.search(),
    },
    getRowId: (row) => this.rowId()(row),
    onSortingChange: (updater) => this.sorting.set(apply(updater, this.effectiveSorting())),
    onColumnFiltersChange: (updater) => this.filters.set(apply(updater, this.effectiveFilters())),
    onGlobalFilterChange: (updater) => this.search.set(apply(updater, this.search())),
    globalFilterFn: 'includesString',
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  }));

  protected readonly columnCount = computed(() => this.columns().length + 1);

  /** Sichtbare Zeilen, bei groupBy in Gruppen mit Überschrift zusammengefasst. */
  protected readonly groups = computed(() => {
    const rows = this.table.getRowModel().rows;
    const id = this.groupBy();
    const column = id ? this.column(id) : undefined;
    if (!rows.length) return [];
    if (!column) return [{ key: '', label: '', rows }];
    const groups = new Map<string, { key: string; label: string; rank: string | number; rows: typeof rows }>();
    for (const row of rows) {
      const label = String(column.value(row.original) ?? '');
      const group = groups.get(label) ?? {
        key: label,
        label,
        rank: (column.sortValue ?? column.value)(row.original) ?? label,
        rows: [],
      };
      group.rows.push(row);
      groups.set(label, group);
    }
    return [...groups.values()].sort((a, b) =>
      typeof a.rank === 'number' && typeof b.rank === 'number'
        ? a.rank - b.rank
        : String(a.rank).localeCompare(String(b.rank), 'de'),
    );
  });

  protected template(id: string): TemplateRef<{ $implicit: unknown }> | null {
    return this.cellTemplates().find((cell) => cell.appDataCell() === id)?.template ?? null;
  }

  protected column(id: string): DataColumn<T> | undefined {
    return this.columns().find((column) => column.id === id);
  }

  protected display(row: T, id: string): string {
    const value = this.column(id)?.value(row);
    return value === null || value === undefined || value === '' ? '–' : String(value);
  }

  /** Werte einer Spalte mit Anzahl, für das Filtermenü. */
  protected facets(id: string): { value: string; count: number }[] {
    const unique = this.table.getColumn(id)?.getFacetedUniqueValues() ?? new Map();
    return [...unique.entries()]
      .map(([value, count]) => ({ value: String(value), count: Number(count) }))
      .filter((entry) => entry.value !== '')
      .sort((a, b) => a.value.localeCompare(b.value, 'de', { numeric: true }));
  }

  protected selected(id: string): string[] {
    return (this.table.getColumn(id)?.getFilterValue() as string[] | undefined) ?? [];
  }

  protected textFilter(id: string): string {
    return (this.table.getColumn(id)?.getFilterValue() as string | undefined) ?? '';
  }

  protected toggleValue(id: string, value: string, checked: boolean): void {
    const current = this.selected(id);
    const next = checked ? [...current, value] : current.filter((entry) => entry !== value);
    this.table.getColumn(id)?.setFilterValue(next.length ? next : undefined);
  }

  protected setText(id: string, value: string): void {
    this.table.getColumn(id)?.setFilterValue(value || undefined);
  }

  protected clearColumn(id: string): void {
    this.table.getColumn(id)?.setFilterValue(undefined);
  }

  protected readonly activeFilters = computed(() =>
    this.effectiveFilters().map((filter) => ({
      id: filter.id,
      label: this.column(filter.id)?.header ?? filter.id,
      text: Array.isArray(filter.value) ? (filter.value as string[]).join(', ') : String(filter.value),
    })),
  );

  /** Zurücksetzen nur zeigen, wenn Suche, Filter oder Sortierung vom Ausgangszustand abweichen. */
  protected readonly changed = computed(() => !!this.search() || this.filters() !== null || this.sorting() !== null);

  protected resetAll(): void {
    this.search.set('');
    this.filters.set(null);
    this.sorting.set(null);
  }

  protected toggleRow(id: string): void {
    this.expanded.update((current) => (current === id ? null : id));
  }

  protected toggleFilterMenu(id: string, event: Event): void {
    event.stopPropagation();
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.menuPosition.set({
      top: box.bottom + 6,
      left: Math.max(8, Math.min(box.left, globalThis.innerWidth - 228)),
    });
    this.openFilter.update((current) => (current === id ? null : id));
  }

  @HostListener('window:scroll')
  @HostListener('window:resize')
  protected closeOnMove(): void {
    if (this.openFilter()) this.openFilter.set(null);
  }

  @HostListener('document:click', ['$event'])
  protected closeFilterMenu(event: Event): void {
    if (!this.openFilter()) return;
    const menu = this.host.nativeElement.querySelector('.dt-filter-menu');
    if (menu && !menu.contains(event.target as Node)) this.openFilter.set(null);
  }
}
