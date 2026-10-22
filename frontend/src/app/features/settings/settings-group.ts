import { Directive, ElementRef, Injectable, afterRenderEffect, inject, input, signal } from '@angular/core';
import { PageSearchService } from '../../core/page-search.service.js';

const STORAGE_KEY = 'devlog.settings.open';

function readOpen(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : [];
  } catch {
    return [];
  }
}

/** Welche Gruppen der Einstellungen aufgeklappt sind – je Gerät gemerkt, zu Beginn alle zu (Übersicht). */
@Injectable({ providedIn: 'root' })
export class SettingsGroups {
  readonly open = signal<ReadonlySet<string>>(new Set(readOpen()));
  private readonly known = new Set<string>();

  register(key: string): void {
    this.known.add(key);
  }

  set(key: string, open: boolean): void {
    if (this.open().has(key) === open) return;
    const next = new Set(this.open());
    if (open) next.add(key);
    else next.delete(key);
    this.save(next);
  }

  all(open: boolean): void {
    this.save(open ? new Set(this.known) : new Set());
  }

  private save(next: Set<string>): void {
    this.open.set(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      // Ohne Speicher (privates Fenster) gilt der Zustand nur bis zum Neuladen.
    }
  }
}

/**
 * Macht ein `<details>` zu einer Einstellungsgruppe: Auf-/Zuklappen bleibt gemerkt, und die Seitensuche klappt
 * passende Gruppen auf und blendet die übrigen aus.
 */
@Directive({
  selector: 'details[appSettingsGroup]',
  standalone: true,
  host: { class: 'panel settings-group fold-panel', '(toggle)': 'toggled()' },
})
export class SettingsGroupDirective {
  readonly key = input.required<string>({ alias: 'appSettingsGroup' });
  private readonly element = inject<ElementRef<HTMLDetailsElement>>(ElementRef).nativeElement;
  private readonly groups = inject(SettingsGroups);
  private readonly search = inject(PageSearchService);
  private searching = false;

  constructor() {
    afterRenderEffect(() => {
      this.groups.register(this.key());
      const query = this.search.query().trim().toLowerCase();
      const open = this.groups.open().has(this.key());
      this.searching = query !== '';
      const match = !this.searching || (this.element.textContent ?? '').toLowerCase().includes(query);
      this.element.hidden = !match;
      this.element.open = this.searching ? match : open;
    });
  }

  protected toggled(): void {
    // Aufklappen durch die Suche ändert den gemerkten Zustand nicht.
    if (!this.searching) this.groups.set(this.key(), this.element.open);
  }
}
