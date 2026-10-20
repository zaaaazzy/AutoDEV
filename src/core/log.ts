const loggedErrors = new Map<string, string>();

/** pg liefert bei ausgefallener Datenbank AggregateErrors ohne Text; der Code (z. B. ECONNREFUSED) ist dann die einzige Information. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: string }).code;
  return error.message || code || error.name;
}

/** Gleiche Fehlermeldungen pro Schlüssel nur einmal ausgeben, bis sie sich ändern oder der Fehler verschwindet. */
export function logOnce(key: string, message: string): void {
  if (loggedErrors.get(key) === message) return;
  loggedErrors.set(key, message);
  console.error(message);
}

/** Marks the error behind a key as gone, so the next failure is logged again. */
export function clearLogged(key: string): void {
  loggedErrors.delete(key);
}

/**
 * Catch handler for background work whose failure must not stop the caller, but must not go unnoticed either:
 * logs once per key and message, then returns the fallback.
 */
export function logged<T = undefined>(key: string, fallback?: T): (error: unknown) => T {
  return (error) => {
    logOnce(key, `[${key}] ${describeError(error)}`);
    return fallback as T;
  };
}
