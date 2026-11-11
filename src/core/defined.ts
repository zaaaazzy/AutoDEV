/** Wert, der laut Aufbau vorhanden sein muss (Treffergruppe, Index in Grenzen, Zeile nach INSERT … RETURNING). */
export function defined<T>(value: T | null | undefined, what = 'Erwarteter Wert'): T {
  if (value === undefined || value === null) throw new Error(`${what} fehlt.`);
  return value;
}
