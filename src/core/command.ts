import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { folderAvailable, missingFolderMessage } from './folder-guard.js';
import { killGroup, trackChild } from './shutdown.js';

export const MAX_CAPTURED_OUTPUT = 120_000;

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

export type CommandExecutor = (
  command: string[],
  cwd: string,
  options?: {
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    onSpawn?: (pid: number) => void;
    onOutput?: (output: string) => void;
    /** Every raw chunk, also beyond the captured-output limit (for parsing streamed agent events). */
    onChunk?: (chunk: string) => void;
    /** Abbruch (Benutzer, Zeitlimit des Agents, Worker-Ende): beendet die ganze Prozessgruppe sofort. */
    signal?: AbortSignal;
  },
) => Promise<CommandResult>;

export function redactOutput(output: string, environment: NodeJS.ProcessEnv): string {
  let safeOutput = output;
  for (const [key, value] of Object.entries(environment)) {
    if (
      value &&
      /(?:PASSWORD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY|ACCESS_KEY|DATABASE_URL)/i.test(key) &&
      value.length >= 4
    ) {
      safeOutput = safeOutput.replaceAll(value, '[REDACTED]');
    }
  }
  return safeOutput.length > MAX_CAPTURED_OUTPUT
    ? `${safeOutput.slice(0, MAX_CAPTURED_OUTPUT)}\n[output truncated]`
    : safeOutput;
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
    let output = '';
    const appendOutput = (text: string): void => {
      if (!text) return;
      options.onChunk?.(text);
      if (output.length < MAX_CAPTURED_OUTPUT + 1_000) {
        output += text.slice(0, MAX_CAPTURED_OUTPUT + 1_000 - output.length);
        options.onOutput?.(output);
      }
    };
    // Je Stream ein Decoder: ein Umlaut, der über eine Chunk-Grenze fällt, wird sonst zu U+FFFD.
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    child.stdout.on('data', (chunk: Buffer) => appendOutput(stdoutDecoder.write(chunk)));
    child.stderr.on('data', (chunk: Buffer) => appendOutput(stderrDecoder.write(chunk)));
    child.once('error', (error: NodeJS.ErrnoException) => {
      // ENOENT kommt auch, wenn der Arbeitsordner fehlt (z. B. externes Laufwerk getrennt) – dann nicht auf PATH zeigen.
      const hint =
        error.code !== 'ENOENT'
          ? ''
          : !folderAvailable(cwd)
            ? ` – Arbeitsordner nicht erreichbar: ${missingFolderMessage(cwd)}`
            : ` – Befehl „${command[0]}“ wurde im PATH des Workers nicht gefunden (PATH=${(options.env ?? process.env).PATH ?? ''}). ` +
              'Absoluten Pfad im Agent-Befehl angeben oder ./scripts/install-worker.sh in einem Terminal erneut ausführen, in dem der Befehl funktioniert.';
      appendOutput(`\n${error.message}${hint}\n`);
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
      appendOutput(stdoutDecoder.end());
      appendOutput(stderrDecoder.end());
      if (signal) {
        appendOutput(`\nProcess ended by ${signal} (timeout or kill).\n`);
      }
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
