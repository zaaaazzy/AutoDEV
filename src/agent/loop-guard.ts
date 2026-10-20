const MIN_PARAGRAPH_CHARS = 40;
/** Dieselbe Zeile so oft direkt hintereinander: das Modell hängt. */
const MAX_CONSECUTIVE_REPEATS = 3;
/**
 * Dieselbe Zeile so oft im ganzen Text: Schleife. Darunter ist Wiederholung in Doku normal (z. B. „- **Timeout**: …“
 * oder ein curl-Beispiel je Endpunkt).
 */
const MAX_TOTAL_REPEATS = 8;
const MAX_IDENTICAL_CALLS = 4;

/** Erkennt, wenn ein Modell sich wiederholt (gleiche Absätze oder immer derselbe Werkzeugaufruf). */
export class LoopGuard {
  private lastCall = '';
  private callStreak = 0;

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

  /** Gibt true zurück, sobald derselbe Werkzeugaufruf mehrfach direkt hintereinander erfolgt. */
  repeatedCall(name: string, args: Record<string, unknown>): boolean {
    const signature = `${name}:${JSON.stringify(args)}`;
    this.callStreak = signature === this.lastCall ? this.callStreak + 1 : 1;
    this.lastCall = signature;
    return this.callStreak >= MAX_IDENTICAL_CALLS;
  }
}
