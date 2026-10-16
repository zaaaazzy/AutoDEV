const MIN_PARAGRAPH_CHARS = 40;
const MAX_PARAGRAPH_REPEATS = 3;
const MAX_IDENTICAL_CALLS = 4;

/** Erkennt, wenn ein Modell sich wiederholt (gleiche Absätze oder immer derselbe Werkzeugaufruf). */
export class LoopGuard {
  private lastCall = '';
  private callStreak = 0;

  /** Gibt eine Beschreibung zurück, wenn ein Absatz in einer Antwort mindestens dreimal vorkommt. */
  repeatedText(text: string): string | null {
    const counts = new Map<string, number>();
    for (const paragraph of text.split(/\n+/)) {
      const normalized = paragraph.replace(/\s+/g, ' ').trim();
      if (normalized.length < MIN_PARAGRAPH_CHARS) continue;
      const count = (counts.get(normalized) ?? 0) + 1;
      counts.set(normalized, count);
      if (count >= MAX_PARAGRAPH_REPEATS) return normalized.slice(0, 120);
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
