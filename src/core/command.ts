import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { folderAvailable, missingFolderMessage } from './folder-guard.js';
import { maskTokens } from './secret-mask.js';
import { killGroup, trackChild } from './shutdown.js';

export const MAX_CAPTURED_OUTPUT = 120_000;
/** Vom Anfang bleibt wenig (Startmeldungen); Fehlerzusammenfassung und Coverage stehen am Ende. */
const HEAD_CHARS = 20_000;
const TAIL_CHARS = MAX_CAPTURED_OUTPUT - HEAD_CHARS;
/** Live-Ausgabe höchstens so oft zusammensetzen (und schwärzen), nicht bei jedem Chunk. */
const LIVE_OUTPUT_INTERVAL_MS = 250;

/** So lange wird nach dem Ende des Prozesses noch auf restliche Ausgabe gewartet, bevor die Pipes geschlossen werden. */
export const OUTPUT_GRACE_MS = 2_000;

export interface CommandResult {
  exitCode: number;
  durationMs: number;
  output: string;
  /** Vom Modell gemeldete Tokens (Prompt + Antwort), falls bekannt. */
  tokens?: number;
  /** Vom Claude-CLI gemeldete API-Kosten in US-Dollar, falls bekannt. */
  costUsd?: number;
  /** Sitzung des Claude-CLI, um das Gespräch später fortzusetzen (--resume). */
  sessionId?: string;
}

export type OutputStream = 'stdout' | 'stderr';

export type CommandExecutor = (
  command: string[],
  cwd: string,
  options?: {
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    onSpawn?: (pid: number) => void;
    onOutput?: (output: string) => void;
    /** Every raw chunk, also beyond the captured-output limit (for parsing streamed agent events). Ohne Stream: stdout. */
    onChunk?: (chunk: string, stream?: OutputStream) => void;
    /** Abbruch (Benutzer, Zeitlimit des Agents, Worker-Ende): beendet die ganze Prozessgruppe sofort. */
    signal?: AbortSignal;
  },
) => Promise<CommandResult>;

/** Werte geheimer Umgebungsvariablen, die in keiner Ausgabe stehen dürfen. */
function secretValues(environment: NodeJS.ProcessEnv): string[] {
  const secrets = new Set<string>();
  for (const [key, value] of Object.entries(environment)) {
    if (
      value &&
      /(?:PASSWORD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY|ACCESS_KEY|DATABASE_URL)/i.test(key) &&
      value.length >= 4
    ) {
      secrets.add(value);
    }
  }
  return [...secrets];
}

const REDACTED = '[REDACTED]';

function redact(text: string, secrets: string[]): string {
  let safeText = text;
  for (const secret of secrets) safeText = safeText.replaceAll(secret, REDACTED);
  return safeText;
}

/** Endet der Kopf mit dem Anfang eines Secrets, liegt der Rest hinter der Schnittkante: diesen Anfang mit entfernen. */
function dropSecretStartAtEnd(text: string, secrets: string[]): string {
  let removed = 0;
  for (const secret of secrets) {
    for (let length = Math.min(secret.length - 1, text.length); length > removed; length -= 1) {
      if (text.endsWith(secret.slice(0, length))) {
        removed = length;
        break;
      }
    }
  }
  return text.slice(0, text.length - removed);
}

/** Beginnt das Ende mit dem Schluss eines Secrets, lag dessen Anfang im verworfenen Mittelstück: mit entfernen. */
function dropSecretEndAtStart(text: string, secrets: string[]): string {
  let removed = 0;
  for (const secret of secrets) {
    for (let length = Math.min(secret.length - 1, text.length); length > removed; length -= 1) {
      if (text.startsWith(secret.slice(-length))) {
        removed = length;
        break;
      }
    }
  }
  return text.slice(removed);
}

/** Erste `length` Zeichen, ohne ein Surrogate-Paar (Emoji) zu zerreissen. */
function headOf(text: string, length: number): string {
  if (text.length <= length) return text;
  const code = text.charCodeAt(length - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length);
}

/** Letzte `length` Zeichen, ohne ein Surrogate-Paar zu zerreissen. */
function tailOf(text: string, length: number): string {
  if (text.length <= length) return text;
  const start = text.length - length;
  const code = text.charCodeAt(start);
  return text.slice(code >= 0xdc00 && code <= 0xdfff ? start + 1 : start);
}

/**
 * Setzt Kopf und Ende einer gekürzten Ausgabe zusammen: erst schwärzen, dann auf die Grenzen kürzen. Ein Secret,
 * das über eine Schnittkante reicht, wird ganz entfernt, damit keine Hälfte sichtbar bleibt.
 */
function joinHeadAndTail(head: string, tail: string, omitted: number, secrets: string[]): string {
  if (!omitted) return redact(head + tail, secrets);
  const safeHead = headOf(redact(dropSecretStartAtEnd(head, secrets), secrets), HEAD_CHARS);
  const safeTail = tailOf(redact(dropSecretEndAtStart(tail, secrets), secrets), TAIL_CHARS);
  return `${safeHead}\n[… ${omitted} Zeichen der Ausgabe ausgelassen …]\n${safeTail}`;
}

/**
 * Schwärzt Secrets und kürzt lange Ausgaben auf Kopf und Ende (das Ende enthält Fehler und Coverage). Neben den Werten
 * aus der Umgebung auch bekannte Token-Formate (maskTokens), etwa aus der Projekt-DB oder aus gelesenen Dateien.
 * tokens: false nur für Ausgaben, die selbst nach Zugangsdaten durchsucht werden (Secret-Holdback des Git-Sync).
 * runCommand schwärzt nur die Umgebung: seine Ausgabe wird noch ausgewertet, gespeichert wird sie über redactOutput.
 */
export function redactOutput(
  output: string,
  environment: NodeJS.ProcessEnv,
  options: { tokens?: boolean } = {},
): string {
  const secrets = secretValues(environment);
  const finish = (text: string): string => (options.tokens === false ? text : maskTokens(text, REDACTED));
  if (output.length <= MAX_CAPTURED_OUTPUT) return finish(redact(output, secrets));
  const head = headOf(output, HEAD_CHARS);
  const tail = tailOf(output.slice(head.length), TAIL_CHARS);
  return finish(joinHeadAndTail(head, tail, output.length - head.length - tail.length, secrets));
}

export const runCommand: CommandExecutor = (command, cwd, options = {}) => {
  return new Promise((resolveCommand) => {
    const startedAt = Date.now();
    // Schon abgebrochen: gar nicht erst starten (ein 'abort'-Listener feuert für ein bereits abgebrochenes Signal nie).
    if (options.signal?.aborted) {
      resolveCommand({ exitCode: 130, durationMs: 0, output: 'Abgebrochen, bevor der Befehl startete.\n' });
      return;
    }
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: options.env ?? process.env,
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const untrack = child.pid ? trackChild(child.pid, { command: command[0], cwd }) : () => undefined;
    if (child.pid) options.onSpawn?.(child.pid);
    // Kopf und Ende getrennt puffern, das Mittelstück verwerfen: Fehlerzusammenfassung und Coverage stehen am Ende,
    // und der Speicher bleibt auch bei endloser Ausgabe begrenzt. Geschwärzt wird beim Zusammensetzen, vor dem Kürzen.
    const secrets = secretValues({ ...process.env, ...options.env });
    let head = '';
    let tail = '';
    let omitted = 0;
    let lastLive = 0;
    const captured = (): string => {
      const kept = tailOf(tail, TAIL_CHARS);
      return joinHeadAndTail(head, kept, omitted + tail.length - kept.length, secrets);
    };
    const appendOutput = (text: string, stream: OutputStream): void => {
      if (!text) return;
      options.onChunk?.(text, stream);
      let rest = text;
      // Sobald etwas ins Ende ging, ist der Kopf zu: sonst rutschte ein späteres Zeichen vor früheren Text.
      if (!tail) {
        const part = headOf(rest, HEAD_CHARS - head.length);
        head += part;
        rest = rest.slice(part.length);
      }
      tail += rest;
      // Erst bei doppelter Grösse kürzen, damit nicht jeder Chunk den ganzen Puffer kopiert.
      if (tail.length > 2 * TAIL_CHARS) {
        const kept = tailOf(tail, TAIL_CHARS);
        omitted += tail.length - kept.length;
        tail = kept;
      }
      if (options.onOutput && Date.now() - lastLive >= LIVE_OUTPUT_INTERVAL_MS) {
        lastLive = Date.now();
        options.onOutput(captured());
      }
    };
    // Je Stream ein Decoder: ein Umlaut, der über eine Chunk-Grenze fällt, wird sonst zu U+FFFD.
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    child.stdout.on('data', (chunk: Buffer) => appendOutput(stdoutDecoder.write(chunk), 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => appendOutput(stderrDecoder.write(chunk), 'stderr'));
    child.once('error', (error: NodeJS.ErrnoException) => {
      // ENOENT kommt auch, wenn der Arbeitsordner fehlt (z. B. externes Laufwerk getrennt) – dann nicht auf PATH zeigen.
      const hint =
        error.code !== 'ENOENT'
          ? ''
          : !folderAvailable(cwd)
            ? ` – Arbeitsordner nicht erreichbar: ${missingFolderMessage(cwd)}`
            : ` – Befehl „${command[0]}“ wurde im PATH des Workers nicht gefunden (PATH=${(options.env ?? process.env).PATH ?? ''}). ` +
              'Absoluten Pfad im Agent-Befehl angeben oder ./scripts/install-worker.sh in einem Terminal erneut ausführen, in dem der Befehl funktioniert.';
      appendOutput(`\n${error.message}${hint}\n`, 'stderr');
    });
    // Eigener Timer statt spawn({ timeout }): der trifft nur den direkten Prozess. Gestartete Server oder Testläufer
    // lebten weiter, hielten stdout offen, und 'close' käme nie.
    const pid = child.pid;
    const kill = (): void => {
      if (pid) killGroup(pid);
      // Ohne Prozessgruppen (Windows) wenigstens den direkten Prozess beenden.
      child.kill('SIGKILL');
    };
    const timer = options.timeoutMs ? setTimeout(kill, options.timeoutMs) : undefined;
    options.signal?.addEventListener('abort', kill, { once: true });
    let grace: NodeJS.Timeout | undefined;
    let finished = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(grace);
      options.signal?.removeEventListener('abort', kill);
      // Nach jedem Befehl, auch bei Erfolg und Fehler: was er im Hintergrund gestartet hat (z. B. Dev-Server aus
      // npm test), endet mit. Erst danach den Eintrag im Prozessregister löschen.
      if (pid) killGroup(pid);
      untrack();
      appendOutput(stdoutDecoder.end(), 'stdout');
      appendOutput(stderrDecoder.end(), 'stderr');
      if (signal) {
        appendOutput(`\nProcess ended by ${signal} (timeout or kill).\n`, 'stderr');
      }
      const output = captured();
      options.onOutput?.(output);
      resolveCommand({ exitCode: code ?? 1, durationMs: Date.now() - startedAt, output });
    };
    // Hält ein Enkelprozess ausserhalb der Gruppe die Pipes offen, nach kurzer Frist trotzdem abschliessen.
    child.once('exit', (code, signal) => {
      grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code, signal);
      }, OUTPUT_GRACE_MS);
    });
    child.once('close', (code, signal) => finish(code, signal));
  });
};
