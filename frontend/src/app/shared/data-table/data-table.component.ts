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
import { selectionState, toggleAll } from './selection.js';

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
  /** Aktive Filter als Chips über der Tabelle zeigen (der Filter selbst wirkt auch ohne Chips). */
  readonly showFilterChips = input(true);
  /**
   * Mehrfachauswahl: Mit einer Funktion, die sagt, welche Zeilen wählbar sind, erscheint vorne eine Spalte mit
   * Häkchen; das Häkchen im Spaltenkopf wählt alle sichtbaren Zeilen aus bzw. ab. Auswahl über [(selection)].
   */
  readonly selectable = input<((row: T) => boolean) | null>(null);
  readonly selection = model<ReadonlySet<string>>(new Set());
  /** VorleseText des Häkchens einer Zeile. */
  readonly selectLabel = input<(row: T) => string>(() => 'Zeile auswählen');

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
      // 1. Klick aufsteigend, 2. Klick absteigend, 3. Klick ohne Sortierung.
      sortDescFirst: false,
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
    enableSortingRemoval: true,
    enableMultiSort: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  }));

  protected readonly columnCount = computed(() => this.columns().length + (this.selectable() ? 2 : 1));

  /** Sichtbare (gefilterte) Zeilen, die ausgewählt werden können. */
  private readonly selectableIds = computed(() => {
    const canSelect = this.selectable();
    if (!canSelect) return [];
    return this.table
      .getRowModel()
      .rows.filter((row) => canSelect(row.original))
      .map((row) => row.id);
  });

  /** Zustand des Häkchens im Spaltenkopf: keine, einige oder alle sichtbaren Zeilen gewählt. */
  protected readonly selectionState = computed<'none' | 'some' | 'all'>(() =>
    selectionState(this.selectableIds(), this.selection()),
  );

  protected readonly hasSelectable = computed(() => this.selectableIds().length > 0);

  protected canSelect(row: T): boolean {
    return this.selectable()?.(row) ?? false;
  }

  protected toggleSelected(id: string): void {
    const next = new Set(this.selection());
    if (!next.delete(id)) next.add(id);
    this.selection.set(next);
  }

  /** Häkchen im Kopf: alle sichtbaren wählbaren Zeilen auswählen oder (wenn schon alle gewählt) abwählen. */
  protected toggleAllSelected(): void {
    this.selection.set(toggleAll(this.selectableIds(), this.selection()));
  }

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

  /** Klick irgendwo in die Zeile öffnet die Details – außer auf Bedienelemente oder beim Markieren von Text. */
  protected rowClick(id: string, event: MouseEvent): void {
    if (!this.detail()) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, select, textarea, label, summary, [role="button"], [contenteditable]'))
      return;
    if (globalThis.getSelection?.()?.toString()) return;
    this.toggleRow(id);
  }

  /** Knopf, der das Filtermenü geöffnet hat: nach Escape erhält er den Fokus zurück. */
  private filterOpener: HTMLElement | null = null;

  protected toggleFilterMenu(id: string, event: Event): void {
    event.stopPropagation();
    this.filterOpener = event.currentTarget as HTMLElement;
    const box = this.filterOpener.getBoundingClientRect();
    this.menuPosition.set({
      top: box.bottom + 6,
      left: Math.max(8, Math.min(box.left, globalThis.innerWidth - 228)),
    });
    this.openFilter.update((current) => (current === id ? null : id));
    // Textfilter: direkt lostippen können.
    if (this.openFilter() === id)
      setTimeout(() =>
        this.host.nativeElement.querySelector<HTMLInputElement>('.dt-filter-menu input[type="search"]')?.focus(),
      );
  }

  /**
   * Sortieren per Klick: aufsteigend → absteigend → ohne. Ist die Spalte nur durch die Voreinstellung sortiert,
   * beginnt der erste Klick trotzdem aufsteigend (bzw. dreht eine aufsteigende Voreinstellung um).
   */
  protected sortBy(id: string, event: Event): void {
    const preset = this.sorting() === null ? this.initialSort().find((entry) => entry.id === id) : undefined;
    if (preset) {
      this.sorting.set([{ id, desc: !preset.desc }]);
      return;
    }
    this.table.getColumn(id)?.getToggleSortingHandler()?.(event);
  }

  /** Leertext: spricht nur von Filtern, wenn es Einträge gibt und wirklich gefiltert oder gesucht wird. */
  protected readonly emptyMessage = computed(() =>
    this.rows().length && (this.activeFilters().length || this.search())
      ? this.emptyText()
      : this.emptyText().replace(/\s+(für|mit|bei)\s+(diese[nmr]?|den gewählten|dem gewählten)\s+Filtern?/i, ''),
  );

  @HostListener('window:scroll')
  @HostListener('window:resize')
  protected closeOnMove(): void {
    if (this.openFilter()) this.openFilter.set(null);
  }

  @HostListener('document:keydown.escape')
  protected closeOnEscape(): void {
    if (!this.openFilter()) return;
    this.openFilter.set(null);
    this.filterOpener?.focus();
  }

  @HostListener('document:click', ['$event'])
  protected closeFilterMenu(event: Event): void {
    if (!this.openFilter()) return;
    const menu = this.host.nativeElement.querySelector('.dt-filter-menu');
    if (menu && !menu.contains(event.target as Node)) this.openFilter.set(null);
  }
}
