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

/** Adds streaming output unless the configured command already chose an output format. */
export function withStreamJson(command: string[]): string[] {
  const [binary, ...rest] = command;
  if (!binary || !isClaudeCommand(command) || rest.some((part) => part.startsWith('--output-format'))) return command;
  return [binary, '--output-format', 'stream-json', '--verbose', ...rest];
}

type ContentBlock = { type?: string; name?: string; text?: string; input?: Record<string, unknown> };
type StreamEvent = {
  type?: string;
  message?: { content?: ContentBlock[] };
  result?: string;
  is_error?: boolean;
  usage?: { input_tokens?: number; output_tokens?: number };
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
  /** Readable log of all actions so far, used as live output while the agent runs. */
  transcript(): string;
  /** Final answer and token usage, or null when no result event arrived (e.g. the CLI failed to start). */
  result(): { text: string; isError: boolean; tokens: number } | null;
}

export function createStreamParser(cwd: string, onAction: (message: string) => void): StreamParser {
  let buffer = '';
  const lines: string[] = [];
  let final: { text: string; isError: boolean; tokens: number } | null = null;
  const action = (message: string): void => {
    if (!message) return;
    lines.push(message);
    onAction(message);
  };
  const handle = (line: string): void => {
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      if (line.trim()) lines.push(line.trim());
      return;
    }
    if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use') action(describeToolUse(block, cwd));
        else if (block.type === 'text' && block.text?.trim()) action(shorten(block.text));
      }
    } else if (event.type === 'result') {
      final = {
        text: event.result ?? '',
        isError: event.is_error === true,
        tokens: (event.usage?.input_tokens ?? 0) + (event.usage?.output_tokens ?? 0),
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
    transcript: () => lines.join('\n'),
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
  options: NonNullable<Parameters<CommandExecutor>[2]> & { onAction?: (message: string) => void },
): Promise<CommandResult> {
  const { onAction, ...executeOptions } = options;
  if (!isClaudeCommand(command)) return execute(command, cwd, executeOptions);
  const parser = createStreamParser(cwd, (message) => onAction?.(message));
  const result = await execute(withStreamJson(command), cwd, {
    ...executeOptions,
    onOutput: undefined,
    onChunk: (chunk) => {
      parser.push(chunk);
      executeOptions.onOutput?.(parser.transcript());
    },
  });
  const final = parser.result();
  if (!final) return result;
  return {
    ...result,
    exitCode: final.isError && result.exitCode === 0 ? 1 : result.exitCode,
    output: final.text || parser.transcript(),
    tokens: final.tokens || result.tokens,
  };
}
