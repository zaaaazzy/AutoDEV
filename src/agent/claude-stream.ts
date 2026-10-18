import { basename } from 'node:path';
import type { CommandExecutor, CommandResult } from '../core/command.js';

/**
 * `claude -p` prints its answer only when it is done. With `--output-format stream-json` it reports every
 * step as one JSON line; this module turns those lines into live progress and restores the plain answer.
 */

const MAX_ACTION_CHARS = 160;

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
type StreamEvent = {
  type?: string;
  session_id?: string;
  message?: { content?: ContentBlock[] };
  result?: string;
  is_error?: boolean;
  usage?: { input_tokens?: number; output_tokens?: number };
  total_cost_usd?: number;
};

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
  /** Feeds raw stdout; complete lines are parsed, the rest waits for the next chunk. */
  push(chunk: string): void;
  /** The agent's Markdown text so far, used as live output while the agent runs. */
  transcript(): string;
  /** Final answer and token usage, or null when no result event arrived (e.g. the CLI failed to start). */
  result(): { text: string; isError: boolean; tokens: number; costUsd: number } | null;
  /** Session of the run, reported in every event; used to continue the conversation. */
  sessionId(): string | undefined;
}

export function createStreamParser(cwd: string, onAction: (message: string) => void): StreamParser {
  let buffer = '';
  // Live output reads like documentation: only the agent's own Markdown text; tool calls go to the history.
  const paragraphs: string[] = [];
  let final: { text: string; isError: boolean; tokens: number; costUsd: number } | null = null;
  let session: string | undefined;
  const action = (message: string): void => {
    if (message) onAction(message);
  };
  const handle = (line: string): void => {
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      if (line.trim()) paragraphs.push(line.trim());
      return;
    }
    if (typeof event.session_id === 'string') session = event.session_id;
    if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use') action(describeToolUse(block, cwd));
        else if (block.type === 'text' && block.text?.trim()) {
          paragraphs.push(block.text.trim());
          action(shorten(block.text));
        }
      }
    } else if (event.type === 'result') {
      final = {
        text: event.result ?? '',
        isError: event.is_error === true,
        tokens: (event.usage?.input_tokens ?? 0) + (event.usage?.output_tokens ?? 0),
        costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : 0,
      };
    }
  };
  return {
    push(chunk) {
      buffer += chunk;
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) handle(line);
    },
    transcript: () => paragraphs.join('\n\n'),
    sessionId: () => session,
    result() {
      if (buffer.trim()) {
        handle(buffer);
        buffer = '';
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
  },
): Promise<CommandResult> {
  const { onAction, resumeSession, ...executeOptions } = options;
  if (!isClaudeCommand(command)) return execute(command, cwd, executeOptions);
  const parser = createStreamParser(cwd, (message) => onAction?.(message));
  const result = await execute(withStreamJson(withResume(command, resumeSession)), cwd, {
    ...executeOptions,
    onOutput: undefined,
    onChunk: (chunk) => {
      parser.push(chunk);
      executeOptions.onOutput?.(parser.transcript());
    },
  });
  const final = parser.result();
  // Without a result event (abort, crash) keep the readable text instead of raw JSON lines.
  if (!final) return { ...result, output: parser.transcript() || result.output, sessionId: parser.sessionId() };
  return {
    ...result,
    sessionId: parser.sessionId(),
    exitCode: final.isError && result.exitCode === 0 ? 1 : result.exitCode,
    output: final.text || parser.transcript(),
    tokens: final.tokens || result.tokens,
    costUsd: final.costUsd || result.costUsd,
  };
}
