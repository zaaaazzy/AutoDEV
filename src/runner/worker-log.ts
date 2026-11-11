/** Meldungen des Workers: gleiche Fehler nur einmal, bis sie sich ändern oder verschwinden. */
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

/** Der Fehler ist weg: Die nächste gleiche Meldung erscheint wieder. */
export function forgetLogged(key: string): void {
  loggedErrors.delete(key);
}
