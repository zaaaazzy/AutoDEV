import { signal } from '@angular/core';
import { FieldError } from '../core/errors.js';

/** Fehlermeldungen je Formularfeld, angezeigt direkt unter dem Feld statt nur oben als Meldung. */
export class FieldErrors {
  private readonly errors = signal<Record<string, string>>({});

  message(field: string): string {
    return this.errors()[field] ?? '';
  }

  /** Prüft ein Pflichtfeld vor dem Absenden; false = leer, die Meldung steht am Feld. */
  require(field: string, value: string, message: string): boolean {
    if (value.trim()) return true;
    this.set(field, message);
    return false;
  }

  set(field: string, message: string): void {
    this.errors.update((errors) => ({ ...errors, [field]: message }));
  }

  clear(field?: string): void {
    if (field === undefined) {
      this.errors.set({});
      return;
    }
    if (!(field in this.errors())) return;
    this.errors.update((errors) => Object.fromEntries(Object.entries(errors).filter(([key]) => key !== field)));
  }

  /** Übernimmt einen Feldfehler der API, wenn das Formular dieses Feld hat; andere Fehler bleiben unverändert. */
  take(error: unknown, form?: HTMLFormElement): void {
    if (!(error instanceof FieldError) || (form && !form.elements.namedItem(error.field))) return;
    this.set(error.field, error.message);
    error.shown = true;
    if (form) focusField(form, error.field);
  }
}

/** Setzt den Fokus auf das Feld, damit Tastatur- und Screenreader-Nutzer direkt beim Fehler landen. */
export function focusField(form: HTMLFormElement, field: string): void {
  const element = form.elements.namedItem(field);
  if (element instanceof HTMLElement) element.focus();
}
