import { basename } from 'node:path';
import type { CommandExecutor, CommandResult, OutputStream } from '../core/command.js';

/**
 * `claude -p` prints its answer only when it is done. With `--output-format stream-json` it reports every
 * step as one JSON line; this module turns those lines into live progress and restores the plain answer.
 */

const MAX_ACTION_CHARS = 160;
/** Lesbarer Text des Agents: ältere Absätze fallen weg, damit der Speicher bei langen Läufen begrenzt bleibt. */
const MAX_TRANSCRIPT_CHARS = 120_000;
/** Eine einzelne Zeile ohne Umbruch darf nicht unbegrenzt wachsen; das result-Ereignis ist weit kleiner. */
const MAX_LINE_CHARS = 20_000_000;
/** Live-Ausgabe höchstens so oft neu zusammensetzen (transcript() kopiert den ganzen Text). */
export const LIVE_TRANSCRIPT_INTERVAL_MS = 500;

export function isClaudeCommand(command: string[]): boolean {
  return command[0] !== undefined && basename(command[0]) === 'claude';
}

/** Continues an earlier Claude session instead of starting a new conversation. */
export function withResume(command: string[], sessionId: string | undefined): string[] {
  const [binary, ...rest] = command;
  if (!binary || !sessionId || !isClaudeCommand(command) || rest.includes('--resume')) return command;
  return [binary, '--resume', sessionId, ...rest];
}

/** Adds streaming output unless the configured command already chose an output format. */
export function withStreamJson(command: string[]): string[] {
  const [binary, ...rest] = command;
  if (!binary || !isClaudeCommand(command) || rest.some((part) => part.startsWith('--output-format'))) return command;
  return [binary, '--output-format', 'stream-json', '--verbose', ...rest];
}

type ContentBlock = { type?: string; name?: string; text?: string; input?: Record<string, unknown> };
type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};
type StreamEvent = {
  type?: string;
  session_id?: string;
  message?: { id?: string; content?: ContentBlock[]; usage?: Usage };
  result?: string;
  is_error?: boolean;
  usage?: Usage;
  total_cost_usd?: number;
};

/** Alle verarbeiteten Tokens: mit Prompt-Caching steckt der Grossteil der Eingabe in den Cache-Feldern. */
function usageTokens(usage: StreamEvent['usage']): number {
  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return (
    count(usage?.input_tokens) +
    count(usage?.cache_creation_input_tokens) +
    count(usage?.cache_read_input_tokens) +
    count(usage?.output_tokens)
  );
}

function shorten(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MAX_ACTION_CHARS ? `${line.slice(0, MAX_ACTION_CHARS - 1)}…` : line;
}

function relative(path: unknown, cwd: string): string {
  const value = typeof path === 'string' ? path : '';
  return value.startsWith(`${cwd}/`) ? value.slice(cwd.length + 1) : value;
}

/** Human-readable line for one tool call, e.g. "Bearbeitet src/app.ts" or "Führt aus: npm test". */
export function describeToolUse(block: ContentBlock, cwd: string): string {
  const input = block.input ?? {};
  switch (block.name) {
    case 'Read':
      return `Liest ${relative(input.file_path, cwd)}`;
    case 'Edit':
    case 'MultiEdit':
      return `Bearbeitet ${relative(input.file_path, cwd)}`;
    case 'Write':
      return `Schreibt ${relative(input.file_path, cwd)}`;
    case 'Bash':
      return `Führt aus: ${shorten(String(input.command ?? ''))}`;
    case 'Grep':
      return `Sucht nach „${shorten(String(input.pattern ?? ''))}“`;
    case 'Glob':
      return `Sucht Dateien ${String(input.pattern ?? '')}`;
    case 'TodoWrite':
      return 'Aktualisiert die Aufgabenliste';
    default:
      return `Nutzt ${block.name ?? 'ein Werkzeug'}`;
  }
}

export interface StreamParser {
  /**
   * Feeds raw output; complete lines are parsed, the rest waits for the next chunk. stdout und stderr haben je einen
   * eigenen Zeilenpuffer, und nur stdout wird als JSON gelesen: stderr kann so nie mitten in ein Ereignis geraten.
   */
  push(chunk: string, stream?: OutputStream): void;
  /** The agent's Markdown text so far, used as live output while the agent runs. */
  transcript(): string;
  /** Final answer and token usage, or null when no result event arrived (e.g. the CLI failed to start). */
  result(): { text: string; isError: boolean; tokens: number; costUsd: number } | null;
  /** Session of the run, reported in every event; used to continue the conversation. */
  sessionId(): string | undefined;
  /**
   * Rückfall ohne result-Ereignis (Timeout, Abbrechen, Absturz): Summe der usage aus den assistant-Ereignissen,
   * je message.id nur der letzte Stand. Kosten gibt es dort nicht, darum nur Tokens.
   */
  streamedTokens(): number;
}

export function createStreamParser(
  cwd: string,
  onAction: (message: string) => void,
  onSession?: (sessionId: string) => void,
): StreamParser {
  const buffers: Record<OutputStream, { text: string; overflow: boolean }> = {
    stdout: { text: '', overflow: false },
    stderr: { text: '', overflow: false },
  };
  // Live output reads like documentation: only the agent's own Markdown text; tool calls go to the history.
  const paragraphs: string[] = [];
  let paragraphChars = 0;
  let paragraphsDropped = false;
  let cached: string | undefined;
  let final: { text: string; isError: boolean; tokens: number; costUsd: number } | null = null;
  let session: string | undefined;
  // Claude schickt eine Nachricht je Inhaltsblock erneut, mit derselben id: nur der letzte Stand zählt.
  const messageTokens = new Map<string, number>();
  const action = (message: string): void => {
    if (message) onAction(message);
  };
  const addParagraph = (text: string): void => {
    paragraphs.push(text);
    paragraphChars += text.length;
    cached = undefined;
    while (paragraphChars > MAX_TRANSCRIPT_CHARS && paragraphs.length > 1) {
      paragraphChars -= paragraphs.shift()?.length ?? 0;
      paragraphsDropped = true;
    }
  };
  const handle = (line: string, stream: OutputStream): void => {
    if (stream === 'stderr') {
      if (line.trim()) addParagraph(line.trim());
      return;
    }
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      if (line.trim()) addParagraph(line.trim());
      return;
    }
    if (typeof event.session_id === 'string' && event.session_id !== session) {
      session = event.session_id;
      // Sofort melden (erstes Ereignis): so ist die Sitzung auch nach einem harten Abbruch bekannt.
      onSession?.(session);
    }
    if (event.type === 'assistant') {
      const usage = event.message?.usage;
      if (usage) messageTokens.set(event.message?.id ?? `ohne-id-${messageTokens.size}`, usageTokens(usage));
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use') action(describeToolUse(block, cwd));
        else if (block.type === 'text' && block.text?.trim()) {
          addParagraph(block.text.trim());
          action(shorten(block.text));
        }
      }
    } else if (event.type === 'result') {
      final = {
        text: event.result ?? '',
        isError: event.is_error === true,
        tokens: usageTokens(event.usage),
        costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : 0,
      };
    }
  };
  return {
    push(chunk, stream = 'stdout') {
      const buffer = buffers[stream];
      if (!chunk.includes('\n')) {
        buffer.text += chunk;
      } else {
        const parts = (buffer.text + chunk).split('\n');
        buffer.text = parts.pop() ?? '';
        for (const line of parts) {
          // Der Rest einer übergrossen Zeile ist kein gültiges Ereignis mehr: verwerfen.
          if (!buffer.overflow) handle(line, stream);
          buffer.overflow = false;
        }
      }
      if (buffer.text.length > MAX_LINE_CHARS) {
        buffer.text = '';
        buffer.overflow = true;
      }
    },
    transcript() {
      cached ??= (paragraphsDropped ? ['[… frühere Ausgabe gekürzt …]', ...paragraphs] : paragraphs).join('\n\n');
      return cached;
    },
    sessionId: () => session,
    streamedTokens() {
      let sum = 0;
      for (const tokens of messageTokens.values()) sum += tokens;
      return sum;
    },
    result() {
      // Die letzte Zeile ohne Zeilenumbruch gehört auch dazu (stdout zuerst: dort steht das result-Ereignis).
      for (const stream of ['stdout', 'stderr'] as const) {
        const buffer = buffers[stream];
        if (buffer.text.trim() && !buffer.overflow) handle(buffer.text, stream);
        buffer.text = '';
        buffer.overflow = false;
      }
      return final;
    },
  };
}

/**
 * Runs an agent command; Claude Code runs in streaming mode so that each step is reported via onAction
 * and the readable log via onOutput. The result carries Claude's plain answer as output.
 */
export async function executeAgentCommand(
  execute: CommandExecutor,
  command: string[],
  cwd: string,
  options: NonNullable<Parameters<CommandExecutor>[2]> & {
    onAction?: (message: string) => void;
    /** Claude-Sitzung, die fortgesetzt werden soll. */
    resumeSession?: string;
    /** Meldet die Sitzung, sobald Claude sie nennt (zum späteren Fortsetzen). */
    onSession?: (sessionId: string) => void;
  },
): Promise<CommandResult> {
  const { onAction, resumeSession, onSession, ...executeOptions } = options;
  if (!isClaudeCommand(command)) return execute(command, cwd, executeOptions);
  const parser = createStreamParser(cwd, (message) => onAction?.(message), onSession);
  // Live-Ausgabe gedrosselt: transcript() je Chunk wäre bei langen Läufen quadratisch.
  let lastLive = 0;
  let shown: string | undefined;
  const showLive = (force: boolean): void => {
    if (!executeOptions.onOutput || (!force && Date.now() - lastLive < LIVE_TRANSCRIPT_INTERVAL_MS)) return;
    lastLive = Date.now();
    const transcript = parser.transcript();
    if (transcript === shown) return;
    shown = transcript;
    executeOptions.onOutput(transcript);
  };
  const result = await execute(withStreamJson(withResume(command, resumeSession)), cwd, {
    ...executeOptions,
    onOutput: undefined,
    onChunk: (chunk, stream) => {
      parser.push(chunk, stream);
      showLive(false);
    },
  });
  const final = parser.result();
  showLive(true);
  // Without a result event (abort, crash) keep the readable text instead of raw JSON lines. Ein Lauf ohne Ergebnis
  // ist nie ein Erfolg: Kosten und is_error wären sonst unbekannt und der Schritt zählte mit Kosten 0 als bestanden.
  // Verbrauchte Tokens zählen trotzdem zum Budget: Rückfall auf die usage der assistant-Ereignisse.
  if (!final) {
    const output = parser.transcript() || result.output;
    const tokens = parser.streamedTokens() || result.tokens;
    if (result.exitCode !== 0) return { ...result, output, tokens, sessionId: parser.sessionId() };
    return {
      ...result,
      tokens,
      exitCode: 1,
      output: `${output}\n\nDie Claude-CLI hat kein Ergebnis gemeldet (result-Ereignis fehlt); der Lauf gilt als fehlgeschlagen.`,
      sessionId: parser.sessionId(),
    };
  }
  return {
    ...result,
    sessionId: parser.sessionId(),
    exitCode: final.isError && result.exitCode === 0 ? 1 : result.exitCode,
    output: final.text || parser.transcript(),
    tokens: final.tokens || result.tokens,
    costUsd: final.costUsd || result.costUsd,
  };
}

/** Liess sich die Sitzung nicht fortsetzen (gelöscht, anderer Ordner)? Dann frisch starten. */
export function resumeFailed(output: string): boolean {
  return /No conversation found|session .*not found|Invalid session/i.test(output);
}
