import { join } from 'node:path';
import { shutdownSignal } from '../core/shutdown.js';
import { type CommandExecutor, type CommandResult, runCommand } from '../core/command.js';
import { DEFAULT_OLLAMA_URL, patientFetch, requestOllamaChat } from './ollama-client.js';
import { resolveContext, resolveModel } from './ollama-client.js';
import { systemPrompt, toolDefinitions } from './ollama-prompts.js';
import { LoopGuard } from './loop-guard.js';
import { BACKUP_DIRECTORY, executeTool, type ToolContext } from './ollama-tools.js';
import type { ChatMessage, ToolCall } from './ollama-types.js';

export { DEFAULT_OLLAMA_MODEL, DEFAULT_OLLAMA_URL } from './ollama-client.js';
export { resolveContext, resolveModel } from './ollama-client.js';
export { composeViolation, isAllowedCommand, isAssistantServiceCommand } from './tool-permissions.js';
export { BACKUP_DIRECTORY, executeTool, type ToolContext } from './ollama-tools.js';

export interface OllamaAgentOptions {
  prompt: string;
  role: string;
  cwd: string;
  timeoutMs: number;
  model?: string;
  baseUrl?: string;
  maxTurns?: number;
  fetchImpl?: typeof fetch;
  execute?: CommandExecutor;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Datenbank-Zugang des Projekts; aktiviert das Werkzeug run_sql für schreibende Rollen. */
  databaseUrl?: string | null;
}

const NO_CHANGE_NEEDED = /^\W*KEINE ÄNDERUNG NÖTIG:/i;
const WRITE_ROLES = new Set(['developer', 'assistant']);
const retryDelays = (): number[] => (process.env.DEV_LOG_OLLAMA_RETRY_MS === '0' ? [] : [3_000, 9_000]);

/** Runs a local Ollama model as a tool-using agent. Without a CLI configured this makes agents work out of the box. */
export async function runOllamaAgent(options: OllamaAgentOptions): Promise<CommandResult> {
  const startedAt = Date.now();
  const model = options.model ?? resolveModel(options.role);
  const contextSize = resolveContext(options.role);
  const keepAlive = process.env.DEV_LOG_OLLAMA_KEEP_ALIVE?.trim() || '30m';
  const baseUrl = (options.baseUrl ?? process.env.DEV_LOG_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? patientFetch;
  const canWrite = WRITE_ROLES.has(options.role);
  const configuredTurns = Number(process.env.DEV_LOG_MAX_TURNS);
  const maxTurns =
    options.maxTurns ??
    (Number.isInteger(configuredTurns) && configuredTurns >= 10 ? Math.min(configuredTurns, 200) : canWrite ? 80 : 25);
  const context: ToolContext = {
    cwd: options.cwd,
    canWrite,
    canManageServices: options.role === 'assistant',
    databaseUrl: canWrite ? options.databaseUrl : null,
    changed: new Set(),
    backupRoot: join(options.cwd, BACKUP_DIRECTORY, new Date().toISOString().replace(/[:.]/g, '-')),
    execute: options.execute ?? runCommand,
    timeoutMs: options.timeoutMs,
  };
  const finish = (exitCode: number, text: string): CommandResult => {
    const files = context.changed.size
      ? `\n\nGeänderte Dateien:\n${[...context.changed].map((file) => `- ${file}`).join('\n')}`
      : '';
    return { exitCode, durationMs: Date.now() - startedAt, output: `${text}${files}` };
  };

  const loopGuard = new LoopGuard();
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(options.role, canWrite, Boolean(context.databaseUrl)) },
    { role: 'user', content: options.prompt },
  ];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const abortOnShutdown = (): void => controller.abort();
  shutdownSignal.addEventListener('abort', abortOnShutdown, { once: true });
  options.signal?.addEventListener('abort', abortOnShutdown, { once: true });
  try {
    for (let turn = 0; turn < maxTurns; turn += 1) {
      const lastTurn = turn === maxTurns - 1;
      if (lastTurn && !canWrite) {
        messages.push({
          role: 'user',
          content:
            'Das Schrittbudget ist aufgebraucht. Antworte jetzt ohne weitere Werkzeuge mit deinem Ergebnis auf ' +
            'Basis des bisher Gelesenen.',
        });
      } else if (turn === maxTurns - 4 && canWrite) {
        messages.push({
          role: 'user',
          content:
            'Hinweis: Nur noch wenige Schritte übrig. Schließe die Änderung jetzt ab, prüfe sie kurz und fasse ' +
            'zusammen.',
        });
      }
      const request = (): Promise<Response> =>
        requestOllamaChat(
          fetchImpl,
          baseUrl,
          {
            model,
            messages,
            tools:
              lastTurn && !canWrite
                ? undefined
                : toolDefinitions(canWrite, context.canManageServices, Boolean(context.databaseUrl)),
            stream: false,
            think: false,
            keep_alive: keepAlive,
            options: { num_ctx: contextSize, temperature: 0.2 },
          },
          controller.signal,
        );
      // Retry brief connection failures (for example, model switching or loading) with increasing delays.
      let response: Response | undefined;
      for (let attempt = 0; response === undefined; attempt += 1) {
        try {
          response = await request();
        } catch (error) {
          const delay = retryDelays()[attempt];
          if (delay === undefined || controller.signal.aborted) throw error;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      if (!response.ok) {
        return finish(1, `Ollama antwortete mit ${response.status}: ${(await response.text()).slice(0, 500)}`);
      }
      const body = (await response.json()) as { message?: ChatMessage };
      const message = body.message;
      if (!message) {
        return finish(1, 'Ollama lieferte keine Nachricht.');
      }
      const repeated = loopGuard.repeatedText(message.content ?? '');
      if (repeated) {
        return finish(1, `Abbruch: Das Modell wiederholt sich („${repeated}…“). Schleife erkannt.`);
      }
      messages.push({ role: 'assistant', content: message.content ?? '', tool_calls: message.tool_calls });
      if (!message.tool_calls?.length) {
        const text = (message.content ?? '').trim();
        if (!text) {
          return finish(1, 'Das Modell lieferte keine Antwort.');
        }
        if (options.role === 'developer' && context.changed.size === 0 && !NO_CHANGE_NEEDED.test(text)) {
          return finish(1, `${text}\n\nDer Entwickler-Agent hat keine Dateien geändert.`);
        }
        return finish(0, text);
      }
      for (const call of message.tool_calls) {
        if (loopGuard.repeatedCall(call.function.name, call.function.arguments)) {
          return finish(1, `Abbruch: Das Modell ruft „${call.function.name}“ wiederholt mit denselben Argumenten auf.`);
        }
        options.onProgress?.(describeToolCall(call));
        const result = await executeTool(context, call);
        messages.push({ role: 'tool', tool_name: call.function.name, content: result });
      }
    }
    return finish(1, `Abbruch: Maximale Anzahl von ${maxTurns} Schritten erreicht.`);
  } catch (error) {
    const reason = controller.signal.aborted
      ? 'Zeitlimit erreicht'
      : `Ollama nicht erreichbar unter ${baseUrl} (${describeError(error)})`;
    return finish(1, reason);
  } finally {
    clearTimeout(timer);
    shutdownSignal.removeEventListener('abort', abortOnShutdown);
    options.signal?.removeEventListener('abort', abortOnShutdown);
  }
}

function describeToolCall(call: ToolCall): string {
  const { name, arguments: args } = call.function;
  const path = typeof args.path === 'string' ? args.path : '.';
  switch (name) {
    case 'list_files':
      return `Lese Ordner: ${path}`;
    case 'read_file':
      return `Lese Datei: ${path}`;
    case 'search_text':
      return `Suche im Projekt: ${(typeof args.query === 'string' ? args.query : '').slice(0, 80)}`;
    case 'write_file':
    case 'replace_in_file':
      return `Ändere Datei: ${path}`;
    case 'run_command':
      return `Führe aus: ${(typeof args.command === 'string' ? args.command : '').slice(0, 100)}`;
    default:
      return 'Untersuche das Projekt …';
  }
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause;
  return cause ? `${error.message}: ${cause.code ?? cause.message}` : error.message;
}
