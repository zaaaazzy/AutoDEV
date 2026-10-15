import { spawn } from 'node:child_process';

export const MAX_CAPTURED_OUTPUT = 120_000;

export interface CommandResult {
  exitCode: number;
  durationMs: number;
  output: string;
}

export type CommandExecutor = (
  command: string[],
  cwd: string,
  options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

export function redactOutput(output: string, environment: NodeJS.ProcessEnv): string {
  let safeOutput = output;
  for (const [key, value] of Object.entries(environment)) {
    if (value && /(?:PASSWORD|SECRET|TOKEN|DATABASE_URL)/i.test(key) && value.length >= 4) {
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
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs,
    });
    let output = '';
    const appendOutput = (chunk: Buffer): void => {
      if (output.length < MAX_CAPTURED_OUTPUT + 1_000) {
        output += chunk.toString('utf8').slice(0, MAX_CAPTURED_OUTPUT + 1_000 - output.length);
      }
    };
    child.stdout.on('data', appendOutput);
    child.stderr.on('data', appendOutput);
    child.once('error', (error) => appendOutput(Buffer.from(`\n${error.message}\n`)));
    child.once('close', (code, signal) => {
      if (signal) {
        appendOutput(Buffer.from(`\nProcess ended by ${signal} (timeout or kill).\n`));
      }
      resolveCommand({ exitCode: code ?? 1, durationMs: Date.now() - startedAt, output });
    });
  });
};
