// Ausführung im Sandbox-Container (Modus docker) bzw. im Arbeitscontainer (Modus workbench, workbench.ts). Konstanten,
// Hilfen und Netzwerk liegen in sandbox-base.ts, damit workbench.ts sie ohne Zyklus importieren kann; von aussen bleibt
// dieses Modul der eine Einstieg.
import { lstatSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type CommandExecutor, type CommandResult, redactOutput, runCommand } from './command.js';
import {
  blocked,
  CHECK_TIMEOUT_MS,
  containerName,
  credentialProblem,
  dockerClientEnvironment,
  dependencyCommand,
  dependencyStamp,
  ensureAgentNetwork,
  INSTALL_TIMEOUT_MS,
  KILL_TIMEOUT_MS,
  modulesVolume,
  noteProblem,
  prepareModulesVolume,
  SANDBOX_LABEL,
  SANDBOX_NETWORK,
  SANDBOX_WORKDIR,
  type SandboxOptions,
  sandboxFailureNote,
  sandboxProblem,
  sandboxRunArgs,
} from './sandbox-base.js';
import { runInWorkbench } from './workbench.js';

export * from './sandbox-base.js';

/**
 * Eigene Agent-Worktrees verlinken node_modules des Hauptordners (agent-workspace.ts). Im Container zeigt der Link auf
 * einen Host-Pfad: Docker hängt das Volume dann dort ein, und npm scheitert an „/workspace/node_modules“ (ENOTDIR).
 * Der Link wird darum durch einen leeren Ordner ersetzt (nur der Link, nie sein Ziel); linkDependencies stellt ihn
 * ohne Sandbox wieder her.
 */
export function replaceLinkedModules(worktree: string): void {
  const path = join(worktree, 'node_modules');
  try {
    if (!lstatSync(path).isSymbolicLink()) return;
    rmSync(path);
    mkdirSync(path);
  } catch {
    // Kein node_modules oder nicht änderbar: Der Lauf geht trotzdem weiter.
  }
}

const installs = new Map<string, Promise<CommandResult>>();

/**
 * Das Volume ist anfangs leer: ohne diesen Schritt fehlen im Container tsx, tsc & Co. (Exit-Code 127). Läuft je
 * Projekt und Lockfile einmal gleichzeitig, im Agent-Netzwerk (npm über den Egress-Proxy), auch wenn die Tests im
 * Compose-Netzwerk des Projekts laufen.
 */
function ensureDependencies(
  worktree: string,
  options: SandboxOptions & { docker?: CommandExecutor; signal?: AbortSignal },
): Promise<CommandResult> | null {
  const stamp = dependencyStamp(worktree);
  if (!stamp) return null;
  const key = `${modulesVolume(options.project)}:${stamp}`;
  let install = installs.get(key);
  if (!install) {
    install = runInSandbox(dependencyCommand(stamp), worktree, {
      runId: options.runId,
      project: options.project,
      platform: options.platform,
      uid: options.uid,
      gid: options.gid,
      image: options.image,
      environment: options.environment,
      docker: options.docker,
      signal: options.signal,
      name: `${options.name ?? containerName(options.runId)}-npm`,
      dependencies: false,
      timeoutMs: INSTALL_TIMEOUT_MS,
    }).finally(() => installs.delete(key));
    installs.set(key, install);
  }
  return install;
}

/**
 * Führt einen Befehl im Sandbox-Container aus. Gleiches Ergebnis wie runCommand (Ausgabe-Streaming, Timeout,
 * Abbruch, Prozessregister über runCommand, geschwärzte Ausgabe). Ein Abbruch oder Timeout beendet den Container
 * (docker kill), nicht nur den Client; nach jedem Ende wird er sicher entfernt. Fehlen Docker, Image oder Anmeldung,
 * scheitert der Lauf mit Meldung – nichts läuft dann auf dem Host.
 */
export async function runInSandbox(
  command: string[],
  worktree: string,
  options: SandboxOptions &
    NonNullable<Parameters<CommandExecutor>[2]> & {
      /** Arbeitsordner auf dem Host (innerhalb des Worktrees); Standard: der Worktree. */
      cwd?: string;
      /** Führt die docker-Befehle aus (Tests); Standard runCommand. */
      docker?: CommandExecutor;
    },
): Promise<CommandResult> {
  if (options.mode === 'workbench' && options.workspace !== false && !options.readOnly) {
    return runInWorkbench(command, worktree, options);
  }
  const { docker = runCommand, signal, timeoutMs, onSpawn, onOutput, onChunk } = options;
  const source = options.environment ?? process.env;
  // Geschwärzt wird gegen alles, was der Worker kennt – auch gegen die Werte der Anmeldedaten.
  const redactWith = { ...process.env, ...source };
  if (signal?.aborted) return { exitCode: 130, durationMs: 0, output: 'Abgebrochen, bevor der Container startete.\n' };
  const env = dockerClientEnvironment(source, options.passEnv);
  const startedAt = Date.now();
  const problem = await sandboxProblem(docker, { image: options.image, environment: source, cwd: worktree });
  if (problem) {
    noteProblem(options.project, problem);
    return blocked(problem, redactWith);
  }
  const missing = credentialProblem(command, source);
  if (missing) {
    noteProblem(options.project, missing);
    return blocked(missing, redactWith);
  }
  if (options.workspace !== false) {
    replaceLinkedModules(worktree);
    const volume = await prepareModulesVolume(docker, options, env, worktree);
    if (volume.exitCode !== 0) {
      const message = `Sandbox: node_modules-Volume „${modulesVolume(options.project)}“ liess sich nicht vorbereiten (Exit-Code ${volume.exitCode}). Der Agent wurde nicht gestartet.\n${volume.output.trim().slice(-500)}`;
      noteProblem(options.project, message.split('\n')[0]);
      return blocked(message, redactWith);
    }
  }
  if (options.workspace !== false && !options.readOnly && options.dependencies !== false) {
    const installed = await ensureDependencies(worktree, { ...options, environment: source });
    if (installed && installed.exitCode !== 0) {
      const message = `Sandbox: Abhängigkeiten liessen sich nicht ins Volume „${modulesVolume(options.project)}“ installieren (Exit-Code ${installed.exitCode}). Befehl nicht gestartet.\n${installed.output.trim().slice(-800)}`;
      noteProblem(options.project, message.split('\n')[0]);
      return blocked(message, redactWith);
    }
  }
  if ((options.network ?? SANDBOX_NETWORK) === SANDBOX_NETWORK) {
    const network = await ensureAgentNetwork(docker, {
      environment: source,
      cwd: worktree,
      platform: options.platform,
      image: options.image,
    });
    if (network) {
      noteProblem(options.project, network);
      return blocked(network, redactWith);
    }
  }
  noteProblem(options.project, null);
  if (signal?.aborted) return { exitCode: 130, durationMs: 0, output: 'Abgebrochen, bevor der Container startete.\n' };
  const name = options.name ?? containerName(options.runId);
  const args = sandboxRunArgs(command, worktree, { ...options, name, environment: source });
  let killing: Promise<unknown> | null = null;
  const killContainer = (): Promise<unknown> => {
    killing ??= docker(['docker', 'kill', name], worktree, { timeoutMs: KILL_TIMEOUT_MS, env }).catch(() => undefined);
    return killing;
  };
  // Abbruch: zuerst den Container beenden (der Client allein liesse ihn weiterlaufen), runCommand beendet den Client.
  const onAbort = (): void => void killContainer();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = timeoutMs ? setTimeout(onAbort, timeoutMs) : undefined;
  let result: CommandResult;
  try {
    result = await docker(args, worktree, { timeoutMs, env, signal, onSpawn, onOutput, onChunk });
  } catch (error) {
    result = { exitCode: 1, durationMs: 0, output: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    // Auch nach Erfolg, Fehler oder getötetem Client: kein Container bleibt zurück (--rm greift nur bei sauberem Ende).
    if (killing) await killing;
    const removed = await docker(['docker', 'rm', '-f', name], worktree, { timeoutMs: KILL_TIMEOUT_MS, env }).catch(
      () => null,
    );
    // Hat --rm das Entfernen schon begonnen, kehrt rm -f sofort zurück („already in progress“): kurz warten, bis er weg ist.
    if (removed && /already in progress/i.test(removed.output)) await waitUntilGone(docker, name, worktree, env);
  }
  const note = signal?.aborted ? null : sandboxFailureNote(result.exitCode, result.output);
  if (note && /^Sandbox:/.test(note)) noteProblem(options.project, note);
  return {
    ...result,
    durationMs: Date.now() - startedAt,
    output: redactOutput(note ? `${result.output}\n\n${note}\n` : result.output, redactWith),
  };
}

async function waitUntilGone(
  docker: CommandExecutor,
  name: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const until = Date.now() + KILL_TIMEOUT_MS;
  while (Date.now() < until) {
    const left = await docker(['docker', 'ps', '-aq', '--filter', `name=^${name}$`], cwd, {
      timeoutMs: CHECK_TIMEOUT_MS,
      env,
    }).catch(() => null);
    if (!left || left.exitCode !== 0 || !left.output.trim()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * CommandExecutor für einen Worktree: jeder Befehl läuft im Sandbox-Container. Arbeitsordner innerhalb des Worktrees
 * werden auf /workspace abgebildet, alles andere auf /workspace selbst.
 */
export function sandboxExecutor(
  worktree: string,
  sandbox: SandboxOptions & { docker?: CommandExecutor },
): CommandExecutor {
  return (command, cwd, options = {}) =>
    runInSandbox(command, worktree, {
      ...sandbox,
      ...options,
      environment: { ...sandbox.environment, ...options.env },
      cwd: cwd === SANDBOX_WORKDIR ? worktree : cwd,
    });
}

/** Beim Start des Workers: übrig gebliebene Sandbox-Container (Label aideation.run) entfernen. */
export async function removeLeftoverContainers(
  docker: CommandExecutor = runCommand,
  cwd: string = process.cwd(),
): Promise<number> {
  const env = dockerClientEnvironment();
  const list = await docker(['docker', 'ps', '-aq', '--filter', `label=${SANDBOX_LABEL}`], cwd, {
    timeoutMs: CHECK_TIMEOUT_MS,
    env,
  }).catch(() => null);
  if (!list || list.exitCode !== 0) return 0;
  const ids = list.output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[a-f0-9]{6,64}$/i.test(line));
  if (!ids.length) return 0;
  const removed = await docker(['docker', 'rm', '-f', ...ids], cwd, { timeoutMs: 60_000, env }).catch(() => null);
  return removed?.exitCode === 0 ? ids.length : 0;
}
