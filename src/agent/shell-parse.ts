// Shell-Tokenizer für den Befehls-Wächter: zerlegt einen Befehl wie Bash in einfache Befehle, Wörter und Umleitungen.

/** Ein Wort nach Bash-Quoting: text ohne Anführungszeichen und Backslashes, raw wie im Befehl. */
export interface ShellWord {
  text: string;
  raw: string;
  /** Wert setzt erst die Shell zusammen: $VAR, $'…', $"…", Klammer-Erweiterung {…} oder ~ am Wortanfang. */
  expanded: boolean;
  /** Ungequotete Glob-Zeichen (* ? [). */
  glob: boolean;
}

/** Umleitung, z. B. „2>“ mit Ziel „/dev/null“; operator enthält einen vorangestellten File-Deskriptor. */
export interface ShellRedirect {
  operator: string;
  target: ShellWord;
}

export interface SimpleCommand {
  words: ShellWord[];
  redirects: ShellRedirect[];
}

/** escapedQuote: \' oder \" ausserhalb von '…' – korrekt zerlegt, verschleiert aber, wo ein Argument endet. */
export type ShellParse =
  { ok: true; commands: SimpleCommand[]; escapedQuote: boolean } | { ok: false; problem: string };

export const CONSTRUCT_PROBLEM =
  'Befehlsersetzung, Subshells und Hintergrund-Befehle („$(…)“, Backticks, „(…)“, „&“) sind gesperrt – Befehle einzeln ausführen.';
const QUOTE_PROBLEM =
  'Offene Anführungszeichen und ein Backslash am Ende sind gesperrt – Argumente vollständig quoten.';
const HEREDOC_PROBLEM = 'Heredocs („<<“) sind gesperrt – Dateien nur mit den Datei-Werkzeugen schreiben.';
const PARAMETER_PROBLEM = 'Parameter-Erweiterungen („${…}“, „$[…]“) sind gesperrt – Werte direkt angeben.';
const SYNTAX_PROBLEM = 'Der Befehl lässt sich nicht eindeutig zerlegen (leerer Teilbefehl oder Umleitung ohne Ziel).';
const KEYWORD_PROBLEM =
  'Shell-Schlüsselwörter („if“, „for“, „while“, „!“, „{ … }“ …) sind gesperrt – Befehle einzeln ausführen.';

/** Reservierte Wörter: an Befehlsposition starten sie Konstrukte, deren Teilbefehle sonst niemand prüfte. */
const RESERVED_WORDS = new Set([
  '!',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'case',
  'esac',
  'for',
  'select',
  'while',
  'until',
  'do',
  'done',
  'in',
  'function',
  'time',
  'coproc',
  '{',
  '}',
  '[[',
  ']]',
]);
/** Umleitungs-Operatoren, längste zuerst; Heredocs (<<, <<-) fängt der Tokenizer vorher ab. */
const REDIRECT_OPERATORS = ['<<<', '&>>', '<>', '<&', '>>', '>&', '>|', '&>', '<', '>'];
const ANSI_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' };

class ParseError extends Error {}

/**
 * Zerlegt einen Befehl wie Bash: Anführungszeichen ('…', "…", $'…'), Backslash-Escapes und Fortsetzungszeilen,
 * Kommentare, Ketten (; && || | |& Zeilenumbruch) und Umleitungen samt File-Deskriptor. Was der Wächter nicht
 * vollständig prüfen kann, liefert ein Problem statt Wörtern (fail-closed): Befehls- und Prozessersetzung,
 * Subshells, Hintergrund-Befehle, Heredocs, ${…}, Schlüsselwörter, offene Anführungszeichen und Syntaxfehler.
 */
export function parseShell(command: string): ShellParse {
  try {
    const parser = new ShellParser(command);
    const commands = parser.parse();
    return { ok: true, commands, escapedQuote: parser.escapedQuote };
  } catch (error) {
    if (error instanceof ParseError) return { ok: false, problem: error.message };
    throw error;
  }
}

class ShellParser {
  private index = 0;
  private readonly commands: SimpleCommand[] = [];
  private current: SimpleCommand = { words: [], redirects: [] };
  private word: ShellWord | null = null;
  private wordStart = 0;
  private redirect: string | null = null;
  /** Letzter Trenner: nach &&, || und | muss ein Befehl folgen (auch erst auf der nächsten Zeile). */
  private separator = ';';
  escapedQuote = false;

  constructor(private readonly source: string) {}

  parse(): SimpleCommand[] {
    while (this.index < this.source.length) this.step();
    this.finishWord();
    if (this.redirect) throw new ParseError(SYNTAX_PROBLEM);
    if (this.hasContent()) this.commands.push(this.current);
    else if (this.separator !== ';') throw new ParseError(SYNTAX_PROBLEM);
    return this.commands;
  }

  private step(): void {
    const char = this.source[this.index] ?? '';
    const next = this.source[this.index + 1];
    if (char === ' ' || char === '\t') {
      this.finishWord();
      this.index += 1;
    } else if (char === '\n') {
      this.separate('\n', 1);
    } else if (char === '#' && !this.word) {
      while (this.index < this.source.length && this.source[this.index] !== '\n') this.index += 1;
    } else if (char === ';') {
      if (next === ';' || next === '&') throw new ParseError(SYNTAX_PROBLEM);
      this.separate(';', 1);
    } else if (char === '|') {
      if (next === '|') this.separate('||', 2);
      else this.separate('|', next === '&' ? 2 : 1);
    } else if (char === '&' && next === '&') {
      this.separate('&&', 2);
    } else if (char === '&' && next !== '>') {
      throw new ParseError(CONSTRUCT_PROBLEM);
    } else if (char === '(' || char === ')' || char === '`') {
      throw new ParseError(CONSTRUCT_PROBLEM);
    } else if (char === '<' || char === '>' || char === '&') {
      this.readRedirect();
    } else {
      this.readWordPart();
    }
  }

  private hasContent(): boolean {
    return this.current.words.length > 0 || this.current.redirects.length > 0;
  }

  private separate(separator: string, length: number): void {
    this.finishWord();
    if (this.redirect) throw new ParseError(SYNTAX_PROBLEM);
    this.index += length;
    if (this.hasContent()) {
      this.commands.push(this.current);
      this.current = { words: [], redirects: [] };
      this.separator = separator === '\n' ? ';' : separator;
    } else if (separator !== '\n') {
      // Leerer Teilbefehl vor ; && || | ist in Bash ein Syntaxfehler; Leerzeilen sind erlaubt.
      throw new ParseError(SYNTAX_PROBLEM);
    }
  }

  private readRedirect(): void {
    if ((this.source[this.index] === '<' || this.source[this.index] === '>') && this.source[this.index + 1] === '(') {
      throw new ParseError(CONSTRUCT_PROBLEM);
    }
    if (this.source.startsWith('<<', this.index) && !this.source.startsWith('<<<', this.index)) {
      throw new ParseError(HEREDOC_PROBLEM);
    }
    // Ein Wort nur aus Ziffern direkt vor der Umleitung ist ihr File-Deskriptor (2>, 10>).
    let descriptor = '';
    if (this.word && /^\d+$/.test(this.source.slice(this.wordStart, this.index))) {
      descriptor = this.word.text;
      this.word = null;
    }
    this.finishWord();
    if (this.redirect) throw new ParseError(SYNTAX_PROBLEM);
    const operator = REDIRECT_OPERATORS.find((candidate) => this.source.startsWith(candidate, this.index)) ?? '';
    this.index += operator.length;
    this.redirect = descriptor + operator;
  }

  private finishWord(): void {
    const word = this.word;
    if (!word) return;
    word.raw = this.source.slice(this.wordStart, this.index);
    this.word = null;
    if (this.redirect) {
      this.current.redirects.push({ operator: this.redirect, target: word });
      this.redirect = null;
    } else {
      if (!this.current.words.length && RESERVED_WORDS.has(word.raw)) throw new ParseError(KEYWORD_PROBLEM);
      this.current.words.push(word);
    }
  }

  private startWord(): ShellWord {
    if (!this.word) {
      this.word = { text: '', raw: '', expanded: false, glob: false };
      this.wordStart = this.index;
    }
    return this.word;
  }

  /** Ein Stück eines Wortes: Escape, Quote-Bereich, $-Erweiterung oder ein gewöhnliches Zeichen. */
  private readWordPart(): void {
    const char = this.source[this.index] ?? '';
    const next = this.source[this.index + 1];
    if (char === '\\') {
      if (next === undefined) throw new ParseError(QUOTE_PROBLEM);
      if (next === "'" || next === '"') this.escapedQuote = true;
      // Backslash + Zeilenumbruch ist eine Fortsetzungszeile: beides fällt weg, das Wort läuft weiter.
      if (next !== '\n') this.startWord().text += next;
      this.index += 2;
      return;
    }
    const word = this.startWord();
    if (char === "'") {
      const end = this.source.indexOf("'", this.index + 1);
      if (end < 0) throw new ParseError(QUOTE_PROBLEM);
      word.text += this.source.slice(this.index + 1, end);
      this.index = end + 1;
    } else if (char === '"') {
      this.index += 1;
      this.readDoubleQuoted(word);
    } else if (char === '$') {
      this.readDollar(word, false);
    } else {
      if ('*?['.includes(char)) word.glob = true;
      if (char === '{' || char === '}' || (char === '~' && !word.text && this.index === this.wordStart)) {
        word.expanded = true;
      }
      word.text += char;
      this.index += 1;
    }
  }

  /** Inhalt von "…" ab dem Zeichen nach dem öffnenden Anführungszeichen; dort wirken \, $ und Backticks weiter. */
  private readDoubleQuoted(word: ShellWord): void {
    while (this.index < this.source.length) {
      const char = this.source[this.index] ?? '';
      const next = this.source[this.index + 1] ?? '';
      if (char === '"') {
        this.index += 1;
        return;
      }
      if (char === '`') throw new ParseError(CONSTRUCT_PROBLEM);
      if (char === '\\' && '$`"\\\n'.includes(next) && next) {
        if (next === '"') this.escapedQuote = true;
        if (next !== '\n') word.text += next;
        this.index += 2;
      } else if (char === '$') {
        this.readDollar(word, true);
      } else {
        word.text += char;
        this.index += 1;
      }
    }
    throw new ParseError(QUOTE_PROBLEM);
  }

  /** $-Erweiterungen: Variablen markieren das Wort als erweitert; Ersetzungen und ${…} sind gesperrt. */
  private readDollar(word: ShellWord, quoted: boolean): void {
    const next = this.source[this.index + 1] ?? '';
    if (next === '(') throw new ParseError(CONSTRUCT_PROBLEM);
    if (next === '{' || next === '[') throw new ParseError(PARAMETER_PROBLEM);
    if (!quoted && next === "'") {
      this.readAnsiC(word);
    } else if (!quoted && next === '"') {
      // $"…" (Übersetzung): wie "…", der Wert hängt aber von der Sprache ab.
      word.expanded = true;
      this.index += 2;
      this.readDoubleQuoted(word);
    } else if (/[A-Za-z_]/.test(next)) {
      const name = /^[A-Za-z_]\w*/.exec(this.source.slice(this.index + 1))?.[0] ?? '';
      word.text += `$${name}`;
      word.expanded = true;
      this.index += 1 + name.length;
    } else if (/[0-9@*#?$!-]/.test(next)) {
      word.text += `$${next}`;
      word.expanded = true;
      this.index += 2;
    } else {
      word.text += '$';
      this.index += 1;
    }
  }

  /** ANSI-C-Quoting $'…': Backslash-Escapes gelten (auch \'); der Wert gilt immer als von der Shell erweitert. */
  private readAnsiC(word: ShellWord): void {
    word.expanded = true;
    this.index += 2;
    while (this.index < this.source.length && this.source[this.index] !== "'") {
      if (this.source[this.index] === '\\') {
        const escaped = this.source[this.index + 1];
        if (escaped === undefined) throw new ParseError(QUOTE_PROBLEM);
        word.text += ANSI_ESCAPES[escaped] ?? `\\${escaped}`;
        this.index += 2;
      } else {
        word.text += this.source[this.index];
        this.index += 1;
      }
    }
    if (this.index >= this.source.length) throw new ParseError(QUOTE_PROBLEM);
    this.index += 1;
  }
}

/** Wörter wieder als Befehlstext (für Meldungen und feste Muster): Wörter mit Sonderzeichen in '…'. */
export function renderWords(words: readonly ShellWord[]): string {
  return words
    .map(({ text, expanded, glob }) =>
      /^[\w@%+=:,./^-]+$/.test(text) && !expanded && !glob ? text : `'${text.replace(/'/g, `'\\''`)}'`,
    )
    .join(' ');
}
