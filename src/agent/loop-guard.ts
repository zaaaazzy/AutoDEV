const MIN_PARAGRAPH_CHARS = 40;
/** Dieselbe Zeile so oft direkt hintereinander: das Modell hängt. */
const MAX_CONSECUTIVE_REPEATS = 3;
/**
 * Dieselbe Zeile so oft im ganzen Text: Schleife. Darunter ist Wiederholung in Doku normal (z. B. „- **Timeout**: …“
 * oder ein curl-Beispiel je Endpunkt).
 */
const MAX_TOTAL_REPEATS = 8;
const MAX_IDENTICAL_CALLS = 4;
/** Längste Folge verschiedener Aufrufe, die als Kreis erkannt wird (z. B. lesen → suchen → lesen → suchen …). */
const MAX_CYCLE_LENGTH = 3;
/** So oft muss eine Folge aus mehreren Aufrufen vollständig direkt hintereinander vorkommen. */
const MIN_CYCLE_REPEATS = 3;
/** Fenster der letzten Aufrufe: reicht für den längsten Kreis mit allen Wiederholungen. */
const CALL_WINDOW = Math.max(MAX_IDENTICAL_CALLS, MAX_CYCLE_LENGTH * MIN_CYCLE_REPEATS);

/** Gleiche Argumente ergeben dieselbe Signatur, auch wenn das Modell die Schlüssel anders ordnet. */
function signatureOf(name: string, args: Record<string, unknown>): string {
  const sorted = (_key: string, value: unknown): unknown =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
      : value;
  return `${name}:${JSON.stringify(args, sorted)}`;
}

/** Endet das Fenster mit einer Folge der Länge `length`, die sich `repeats`-mal unverändert wiederholt? */
function endsWithCycle(calls: readonly string[], length: number, repeats: number): boolean {
  const span = length * repeats;
  if (calls.length < span) return false;
  const tail = calls.slice(-span);
  return tail.every((call, index) => call === tail[index % length]);
}

/** Erkennt, wenn ein Modell sich wiederholt (gleiche Absätze oder immer derselbe Werkzeugaufruf bzw. Kreis). */
export class LoopGuard {
  private calls: string[] = [];

  /**
   * Gibt eine Beschreibung zurück, wenn sich eine Zeile direkt hintereinander (3×) oder sehr oft im Text (8×)
   * wiederholt. Reine Trenn- und Rahmenlinien („=====“, „-----“, „| --- |“) zählen nicht.
   */
  repeatedText(text: string): string | null {
    const counts = new Map<string, number>();
    let previous = '';
    let streak = 0;
    for (const paragraph of text.split(/\n+/)) {
      const normalized = paragraph.replace(/\s+/g, ' ').trim();
      if (normalized.length < MIN_PARAGRAPH_CHARS || !/[\p{L}\p{N}]/u.test(normalized)) {
        previous = '';
        streak = 0;
        continue;
      }
      streak = normalized === previous ? streak + 1 : 1;
      previous = normalized;
      const count = (counts.get(normalized) ?? 0) + 1;
      counts.set(normalized, count);
      if (streak >= MAX_CONSECUTIVE_REPEATS || count >= MAX_TOTAL_REPEATS) return normalized.slice(0, 120);
    }
    return null;
  }

  /**
   * Gibt true zurück, sobald derselbe Werkzeugaufruf 4× direkt hintereinander erfolgt oder sich eine Folge aus zwei bis
   * drei Aufrufen mit denselben Argumenten 3× wiederholt (A → B → A → B → A → B). Geprüft wird ein Fenster der letzten
   * Aufrufe; Aufrufe mit neuen Argumenten (z. B. geänderter Inhalt) unterbrechen den Kreis.
   */
  repeatedCall(name: string, args: Record<string, unknown>): boolean {
    this.calls.push(signatureOf(name, args));
    if (this.calls.length > CALL_WINDOW) this.calls.shift();
    if (endsWithCycle(this.calls, 1, MAX_IDENTICAL_CALLS)) return true;
    for (let length = 2; length <= MAX_CYCLE_LENGTH; length += 1) {
      if (endsWithCycle(this.calls, length, MIN_CYCLE_REPEATS)) return true;
    }
    return false;
  }
}
