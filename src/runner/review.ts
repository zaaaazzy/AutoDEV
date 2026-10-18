/** Anweisung an den Reviewer: Änderungen des Auftrags prüfen, nichts ändern, eindeutig freigeben oder ablehnen. */
export function reviewInstructions(base: string | null): string {
  const diff = base
    ? `\`git diff ${base}...HEAD\` sowie \`git diff\` und \`git status\``
    : '`git diff` und `git status`';
  return `## Code-Review (Pflicht für den Reviewer)
1. Sieh dir alle Änderungen dieses Auftrags an: ${diff}.
2. Prüfe sie gegen Ziel, Anforderungen und Akzeptanzkriterien des Auftrags, die Leitlinien des Projekts, Lesbarkeit, Fehlerbehandlung, Sicherheit (keine Geheimnisse im Code, Eingaben geprüft) und ob passende Tests vorhanden sind.
3. Ändere selbst keinen Code.
4. Liste Befunde nummeriert mit Datei und Begründung. Unterscheide „blockierend“ und „Hinweis“.
5. Beende die Antwort mit genau einer Zeile:
@@REVIEW: FREIGEGEBEN   (keine blockierenden Befunde)
@@REVIEW: ÄNDERUNGEN NÖTIG   (mindestens ein blockierender Befund)`;
}

const VERDICT = /^@@REVIEW:\s*(FREIGEGEBEN|ÄNDERUNGEN NÖTIG|AENDERUNGEN NOETIG)\s*$/im;

/** true = freigegeben, false = Änderungen nötig, null = kein eindeutiges Ergebnis. */
export function parseReview(output: string): boolean | null {
  const match = VERDICT.exec(output)?.[1]?.toUpperCase();
  if (!match) return null;
  return match === 'FREIGEGEBEN';
}
