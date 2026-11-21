// Befehlszeilen aus Einstellungen und Umgebungsvariablen in Argumente zerlegen – wie eine POSIX-Shell, aber ohne
// Expansion. Die Datei bleibt ohne Imports, weil das Frontend sie direkt einbindet.

export const QUOTE_NOT_CLOSED = 'Anführungszeichen nicht geschlossen';
export const BACKSLASH_AT_END = 'Backslash am Zeilenende';

type Quote = '"' | "'" | null;

/** In doppelten Anführungszeichen maskiert der Backslash nur diese Zeichen; sonst bleibt er stehen (POSIX). */
const ESCAPABLE_IN_DOUBLE_QUOTES = new Set(['"', '\\', '$', '`']);

/**
 * Zerlegt eine Zeile in Wörter: Leerraum trennt, einfache und doppelte Anführungszeichen gruppieren (und fallen weg),
 * Backslash maskiert das nächste Zeichen (nicht in einfachen Anführungszeichen). Variablen, Pipes und Umleitungen
 * werden nicht ausgewertet, sie bleiben gewöhnliche Wörter. Unausgeglichene Anführungszeichen oder ein Backslash am
 * Ende werfen einen Fehler mit deutscher Meldung, die der Aufrufer dem Nutzer durchreicht.
 */
export function splitShellLine(line: string): string[] {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  let quote: Quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line.charAt(index);
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (char === '\\') {
      if (index + 1 >= line.length) throw new Error(BACKSLASH_AT_END);
      const next = line.charAt(index + 1);
      current += quote === '"' && !ESCAPABLE_IN_DOUBLE_QUOTES.has(next) ? `\\${next}` : next;
      index += 1;
      inWord = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inWord = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (inWord) words.push(current);
      current = '';
      inWord = false;
      continue;
    }
    current += char;
    inWord = true;
  }
  if (quote !== null) throw new Error(QUOTE_NOT_CLOSED);
  if (inWord) words.push(current);
  return words;
}

/** Wort so schreiben, dass splitShellLine es unverändert zurückliefert: nur bei Bedarf in doppelte Anführungszeichen. */
export function quoteShellWord(word: string): string {
  if (word !== '' && !/[\s"'\\]/.test(word)) return word;
  return `"${word.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
}

/** Gegenstück zu splitShellLine: Argumente als eine Zeile, Argumente mit Leerzeichen in Anführungszeichen. */
export function joinShellLine(words: readonly string[]): string {
  return words.map(quoteShellWord).join(' ');
}
