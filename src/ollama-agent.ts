import { copyFile, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { shutdownSignal } from './shutdown.js';
import { type CommandExecutor, type CommandResult, runCommand } from './command.js';
import { Agent, fetch as undiciFetch } from 'undici';

// Lokale Modelle brauchen oft Minuten pro Antwort; Node-Standardlimits (5 min) würden sonst „fetch failed“ liefern.
const patientDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 });
const patientFetch = ((url: string, init?: RequestInit) =>
  undiciFetch(url, { ...init, dispatcher: patientDispatcher } as never)) as unknown as typeof fetch;

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_MODEL = 'qwen3.5:9b';
export const BACKUP_DIRECTORY = '.dev-log-backups';

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', '.angular', BACKUP_DIRECTORY, '.cache', 'coverage']);
const NO_CHANGE_NEEDED = /^\W*KEINE ÄNDERUNG NÖTIG:/i;
const MAX_TOOL_OUTPUT = 8_000;
const MAX_FILE_BYTES = 400_000;
const WRITE_ROLES = new Set(['developer']);
const COMMAND_PATTERN = /^(?:npm (?:test|run [a-z0-9:_-]+)(?: [\w@:./=-]+)*|git (?:status|diff|log)(?: [\w@:./~^][\w@:./=~^-]*)*)$/;
const PACKAGE_SPEC = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+(?:@[\w.^~<>=*-]+)?$/i;
const INSTALL_FLAGS = new Set(['--save', '--save-dev', '-D', '--save-exact', '-E', '--legacy-peer-deps', '--no-audit', '--no-fund', '--ignore-scripts']);
const SAFE_COMMANDS = [
  /^npm (?:ls|list|outdated|audit|doctor)(?: --(?:depth=\d|json|production|omit=dev))*$/,
  /^npm (?:ci|install|i)(?: (?:--[a-z-]+|-[DE]))*$/,
  /^node (?:--version|--check [\w./-]+)$/,
  /^npx --no-install (?:tsc --noEmit|eslint [\w./*-]+|prettier --check [\w./*-]+|jest|vitest run)$/,
];

/** Erlaubt feste, ungefährliche Befehle; `npm install <paket>` nur mit geprüften Paketnamen und Schaltern (kein -g, keine URLs). */
export function isAllowedCommand(command: string): boolean {
  if (COMMAND_PATTERN.test(command)) return true;
  const parts = command.split(/\s+/);
  if (parts[0] === 'npm' && ['install', 'i', 'uninstall'].includes(parts[1] ?? '') && parts.length > 2) {
    return parts.slice(2).every((part) => part.startsWith('-') ? INSTALL_FLAGS.has(part) : PACKAGE_SPEC.test(part));
  }
  return SAFE_COMMANDS.some((pattern) => pattern.test(command));
}

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
}

interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

interface ChatMessage {
  role: string;
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

const clip = (text: string, max = MAX_TOOL_OUTPUT): string =>
  text.length > max ? `${text.slice(0, max)}\n[gekürzt, ${text.length - max} Zeichen]` : text;

const parameter = (description: string, type = 'string'): { type: string; description: string } => ({ type, description });

function toolDefinitions(canWrite: boolean): unknown[] {
  const tools: { name: string; description: string; properties: Record<string, unknown>; required: string[] }[] = [
    {
      name: 'list_files', description: 'Listet Dateien und Ordner eines Verzeichnisses (Ordner enden mit /).',
      properties: { path: parameter('Relativer Pfad, "." für das Projektverzeichnis') }, required: ['path'],
    },
    {
      name: 'read_file', description: 'Liest eine Textdatei (optional ab Zeile start_line, max. 300 Zeilen).',
      properties: { path: parameter('Relativer Dateipfad'), start_line: parameter('Erste Zeile (1-basiert)', 'integer') },
      required: ['path'],
    },
    {
      name: 'search_text', description: 'Sucht einen Text (ohne Regex) in allen Textdateien unterhalb eines Pfads.',
      properties: { query: parameter('Suchtext'), path: parameter('Relativer Startpfad, Standard ".".') }, required: ['query'],
    },
  ];
  if (canWrite) {
    tools.push(
      {
        name: 'write_file', description: 'Schreibt eine Datei vollständig (legt fehlende Ordner an, sichert das Original).',
        properties: { path: parameter('Relativer Dateipfad'), content: parameter('Vollständiger neuer Inhalt') },
        required: ['path', 'content'],
      },
      {
        name: 'replace_in_file', description: 'Ersetzt genau eine Textstelle in einer Datei.',
        properties: {
          path: parameter('Relativer Dateipfad'), old_text: parameter('Exakter bisheriger Text (muss genau einmal vorkommen)'),
          new_text: parameter('Neuer Text'),
        },
        required: ['path', 'old_text', 'new_text'],
      },
      {
        name: 'run_command', description: 'Führt npm install/ci <paket>, npm test, npm run <script>, npm ls/outdated/audit, node --check, npx --no-install tsc/eslint/prettier/jest/vitest oder git status/diff/log aus.',
        properties: { command: parameter('z. B. "npm run build" oder "npm test"') }, required: ['command'],
      },
    );
  }
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: { type: 'object', properties: tool.properties, required: tool.required },
    },
  }));
}

function systemPrompt(role: string, canWrite: boolean): string {
  return [
    `Du bist ein autonomer Software-Agent mit der Rolle "${role}" und arbeitest im Projektverzeichnis.`,
    'Erkunde das Projekt zuerst mit den Werkzeugen, bevor du Aussagen machst oder Code schreibst. Erfinde keine Dateien oder Ergebnisse.',
    canWrite
      ? 'Du darfst Dateien mit write_file/replace_in_file ändern. Halte Änderungen klein, passe vorhandenen Stil an, schreibe Tests und installiere fehlende Abhängigkeiten mit run_command ("npm install"), prüfe mit run_command ("npm run build", "npm test"). Beende die Arbeit mit einer kurzen Zusammenfassung der Änderungen. Ist der Auftrag nachweislich bereits vollständig umgesetzt, beginne die Antwort mit "KEINE ÄNDERUNG NÖTIG:" und nenne die geprüften Dateien als Beleg.'
      : 'Du darfst nichts verändern. Gib dein Ergebnis als Text in Markdown aus (ohne Werkzeugaufruf als letzte Nachricht). Arbeite effizient: höchstens etwa 8 Werkzeugaufrufe, lies nur die wirklich relevanten Dateien (README, package.json, betroffene Module) und antworte dann.',
    'Antworte auf Deutsch.',
  ].join('\n');
}

class ToolError extends Error {}

async function resolveInside(cwd: string, requested: unknown, forWrite = false): Promise<string> {
  if (typeof requested !== 'string' || !requested || requested.includes('\0')) {
    throw new ToolError('Ungültiger Pfad.');
  }
  const root = await realpath(cwd);
  const target = resolve(root, requested);
  const rel = relative(root, target);
  if (rel.startsWith('..') || resolve(root, rel) !== target) {
    throw new ToolError('Pfad liegt außerhalb des Projektverzeichnisses.');
  }
  const parts = rel.split(sep).filter(Boolean);
  if (parts.some((part) => part === '.git' || part === 'node_modules' || part === BACKUP_DIRECTORY
    || /^\.env/.test(part) || /\.(pem|key)$/.test(part))) {
    throw new ToolError('Zugriff auf diesen Pfad ist nicht erlaubt.');
  }
  // Resolve symlinks of the nearest existing ancestor so they cannot point outside the project.
  let existing = target;
  for (;;) {
    try {
      const real = await realpath(existing);
      if (real !== root && !real.startsWith(root + sep)) {
        throw new ToolError('Pfad liegt außerhalb des Projektverzeichnisses.');
      }
      break;
    } catch (error) {
      if (error instanceof ToolError) {
        throw error;
      }
      if (!forWrite && existing === target) {
        throw new ToolError('Pfad existiert nicht.');
      }
      existing = dirname(existing);
    }
  }
  return target;
}

async function walkText(directory: string, root: string, query: string, matches: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (matches.length >= 50) {
      return;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        await walkText(path, root, query, matches);
      }
    } else if (entry.isFile() && !/^\.env/.test(entry.name) && (await stat(path)).size < MAX_FILE_BYTES) {
      const lines = (await readFile(path, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        if (matches.length < 50 && line.includes(query)) {
          matches.push(`${relative(root, path)}:${index + 1}: ${line.trim().slice(0, 200)}`);
        }
      });
    }
  }
}

export interface ToolContext {
  cwd: string;
  canWrite: boolean;
  changed: Set<string>;
  backupRoot: string;
  execute: CommandExecutor;
  timeoutMs: number;
}

async function backup(context: ToolContext, target: string): Promise<void> {
  const rel = relative(await realpath(context.cwd), target);
  const destination = join(context.backupRoot, rel);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(target, destination).catch(() => undefined);
}

/** Executes one tool call; failures are returned as text so the model can correct itself. */
export async function executeTool(context: ToolContext, call: ToolCall): Promise<string> {
  const { name, arguments: args } = call.function;
  try {
    switch (name) {
      case 'list_files': {
        const directory = await resolveInside(context.cwd, args.path ?? '.');
        const entries = (await readdir(directory, { withFileTypes: true }))
          .filter((entry) => !SKIPPED_DIRECTORIES.has(entry.name) && !/^\.env/.test(entry.name))
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).sort();
        return clip(entries.join('\n') || '(leer)');
      }
      case 'read_file': {
        const file = await resolveInside(context.cwd, args.path);
        if ((await stat(file)).size > MAX_FILE_BYTES) {
          return 'Datei ist zu groß.';
        }
        const start = Math.max(1, Number(args.start_line ?? 1) || 1);
        const lines = (await readFile(file, 'utf8')).split('\n');
        const slice = lines.slice(start - 1, start - 1 + 300);
        return clip(`${slice.join('\n')}${start - 1 + 300 < lines.length ? `\n[weitere Zeilen ab ${start + 300}]` : ''}`);
      }
      case 'search_text': {
        if (typeof args.query !== 'string' || args.query.length < 2) {
          return 'Suchtext zu kurz.';
        }
        const start = await resolveInside(context.cwd, args.path ?? '.');
        const matches: string[] = [];
        await walkText(start, await realpath(context.cwd), args.query, matches);
        return clip(matches.join('\n') || 'Keine Treffer.');
      }
      case 'write_file': {
        if (!context.canWrite) {
          return 'Schreiben ist für diese Rolle nicht erlaubt.';
        }
        if (typeof args.content !== 'string' || args.content.length > 400_000) {
          return 'Ungültiger Inhalt.';
        }
        const target = await resolveInside(context.cwd, args.path, true);
        await backup(context, target);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, args.content, 'utf8');
        context.changed.add(relative(await realpath(context.cwd), target));
        return `${relative(context.cwd, target)} geschrieben (${args.content.length} Zeichen).`;
      }
      case 'replace_in_file': {
        if (!context.canWrite) {
          return 'Schreiben ist für diese Rolle nicht erlaubt.';
        }
        if (typeof args.old_text !== 'string' || typeof args.new_text !== 'string' || !args.old_text) {
          return 'old_text und new_text müssen Texte sein.';
        }
        const target = await resolveInside(context.cwd, args.path);
        const content = await readFile(target, 'utf8');
        const occurrences = content.split(args.old_text).length - 1;
        if (occurrences !== 1) {
          return `old_text kommt ${occurrences}-mal vor, erwartet genau 1.`;
        }
        await backup(context, target);
        await writeFile(target, content.replace(args.old_text, () => args.new_text as string), 'utf8');
        context.changed.add(relative(await realpath(context.cwd), target));
        return 'Ersetzt.';
      }
      case 'run_command': {
        if (!context.canWrite) {
          return 'Befehle sind für diese Rolle nicht erlaubt.';
        }
        const command = typeof args.command === 'string' ? args.command.trim() : '';
        if (!isAllowedCommand(command)) {
          return 'Befehl nicht erlaubt. Erlaubt: npm install/ci/uninstall <paket>, npm test|run <script>|ls|outdated|audit, node --check <datei>, npx --no-install tsc|eslint|prettier|jest|vitest, git status|diff|log.';
        }
        const result = await context.execute(command.split(/\s+/), context.cwd, {
          timeoutMs: Math.min(context.timeoutMs, 10 * 60_000),
        });
        return clip(`Exit-Code ${result.exitCode}\n${result.output.slice(-MAX_TOOL_OUTPUT)}`);
      }
      default:
        return `Unbekanntes Werkzeug: ${name}`;
    }
  } catch (error) {
    return `Fehler: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Runs a local Ollama model as a tool-using agent. Without a CLI configured this makes agents work out of the box. */
export async function runOllamaAgent(options: OllamaAgentOptions): Promise<CommandResult> {
  const startedAt = Date.now();
  const model = options.model ?? process.env.DEV_LOG_OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL;
  const baseUrl = (options.baseUrl ?? process.env.DEV_LOG_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? patientFetch;
  const canWrite = WRITE_ROLES.has(options.role);
  const configuredTurns = Number(process.env.DEV_LOG_MAX_TURNS);
  const maxTurns = options.maxTurns ?? (Number.isInteger(configuredTurns) && configuredTurns >= 10 ? Math.min(configuredTurns, 200) : canWrite ? 80 : 25);
  const context: ToolContext = {
    cwd: options.cwd,
    canWrite,
    changed: new Set(),
    backupRoot: join(options.cwd, BACKUP_DIRECTORY, new Date().toISOString().replace(/[:.]/g, '-')),
    execute: options.execute ?? runCommand,
    timeoutMs: options.timeoutMs,
  };
  const finish = (exitCode: number, text: string): CommandResult => {
    const files = context.changed.size ? `\n\nGeänderte Dateien:\n${[...context.changed].map((file) => `- ${file}`).join('\n')}` : '';
    return { exitCode, durationMs: Date.now() - startedAt, output: `${text}${files}` };
  };

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(options.role, canWrite) },
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
        messages.push({ role: 'user', content: 'Das Schrittbudget ist aufgebraucht. Antworte jetzt ohne weitere Werkzeuge mit deinem Ergebnis auf Basis des bisher Gelesenen.' });
      } else if (turn === maxTurns - 4 && canWrite) {
        messages.push({ role: 'user', content: 'Hinweis: Nur noch wenige Schritte übrig. Schließe die Änderung jetzt ab, prüfe sie kurz und fasse zusammen.' });
      }
      const request = (): Promise<Response> => fetchImpl(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model, messages, tools: lastTurn && !canWrite ? undefined : toolDefinitions(canWrite), stream: false, think: false,
          options: { num_ctx: 32_768, temperature: 0.2 },
        }),
      });
      // Kurze Verbindungsabbrüche (z. B. Modellwechsel in Ollama) werden einmal wiederholt.
      const response = await request().catch(async () => {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return request();
      });
      if (!response.ok) {
        return finish(1, `Ollama antwortete mit ${response.status}: ${(await response.text()).slice(0, 500)}`);
      }
      const body = await response.json() as { message?: ChatMessage };
      const message = body.message;
      if (!message) {
        return finish(1, 'Ollama lieferte keine Nachricht.');
      }
      messages.push({ role: 'assistant', content: message.content ?? '', tool_calls: message.tool_calls });
      if (!message.tool_calls?.length) {
        const text = (message.content ?? '').trim();
        if (!text) {
          return finish(1, 'Das Modell lieferte keine Antwort.');
        }
        if (canWrite && context.changed.size === 0 && !NO_CHANGE_NEEDED.test(text)) {
          return finish(1, `${text}\n\nDer Entwickler-Agent hat keine Dateien geändert.`);
        }
        return finish(0, text);
      }
      for (const call of message.tool_calls) {
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

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause;
  return cause ? `${error.message}: ${cause.code ?? cause.message}` : error.message;
}
