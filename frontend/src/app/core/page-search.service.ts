import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { ProjectStore } from './project-store.js';

/**
 * Eine Suche für die ganze Seite, im Seitenkopf statt in jeder Tabelle: Tabellen und Dokumentation lesen den Begriff
 * von hier. Das Feld erscheint nur, solange etwas auf der Seite durchsuchbar ist; ein Seitenwechsel leert es.
 */
@Injectable({ providedIn: 'root' })
export class PageSearchService {
  readonly query = signal('');
  /** Eigener Platzhalter der Seite (z. B. Dokumentation), sonst „Seite durchsuchen …“. */
  readonly placeholder = signal<string | null>(null);
  private readonly users = signal(0);
  readonly available = computed(() => this.users() > 0);

  constructor() {
    const store = inject(ProjectStore);
    effect(() => {
      store.section();
      this.query.set('');
    });
  }

  /** Durchsuchbaren Inhalt anmelden; die zurückgegebene Funktion meldet ihn wieder ab. */
  register(): () => void {
    this.users.update((count) => count + 1);
    return () => this.users.update((count) => Math.max(0, count - 1));
  }
}
