export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** Fehler, den die API einem Formularfeld zuordnet (Antwort mit `field`). */
export class FieldError extends Error {
  /** true, sobald ein Formular die Meldung am Feld zeigt; dann braucht es keine zusätzliche Meldung oben. */
  shown = false;

  constructor(
    message: string,
    readonly field: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
