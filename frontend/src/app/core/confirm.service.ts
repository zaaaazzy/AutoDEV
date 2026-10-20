import { Injectable, signal } from '@angular/core';

/** Was vor einer Aktion bestätigt werden soll (z. B. „Erneut versuchen“, Sprint übernehmen, Schnellaktion). */
export interface ConfirmOptions {
  title: string;
  /** Kurz, was beim Bestätigen passiert. */
  message: string;
  /** Optionale Einzelheiten, z. B. die betroffenen Aufträge oder Befehle. */
  details?: string[];
  confirmLabel: string;
  /** Beschriftung des Kommentarfelds; der Kommentar ist immer optional. */
  commentLabel?: string;
  commentPlaceholder?: string;
  /** Kurzer Hinweis unter dem Feld, wofür der Kommentar verwendet wird. */
  commentHint?: string;
}

export interface ConfirmResult {
  comment: string;
}

interface PendingConfirm {
  options: ConfirmOptions;
  resolve: (result: ConfirmResult | null) => void;
}

/**
 * Bestätigung mit Kommentar in einem eigenen Dialog. Aufrufer warten auf das Ergebnis:
 * `const answer = await confirm.ask({...}); if (!answer) return;` – `null` heisst abgebrochen.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly pending = signal<PendingConfirm | null>(null);

  ask(options: ConfirmOptions): Promise<ConfirmResult | null> {
    // Ein offener Dialog wird abgebrochen, bevor ein neuer erscheint.
    this.pending()?.resolve(null);
    return new Promise((resolve) => this.pending.set({ options, resolve }));
  }

  /** Vom Dialog aufgerufen: bestätigen (mit Kommentar) oder abbrechen (null). */
  settle(result: ConfirmResult | null): void {
    const current = this.pending();
    if (!current) return;
    this.pending.set(null);
    current.resolve(result);
  }
}
