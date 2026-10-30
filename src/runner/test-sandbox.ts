// Projekttests in der Docker-Sandbox (Tester-Schritt, Test-Gate beim Live schalten, Komplettlauf test:full,
// Abdeckungsmessung): Der Host führt keinen Projektcode mehr aus. Braucht das Projekt Dienste (z. B. Datenbank),
// startet der Worker sie per Compose und hängt den Testcontainer nur an das Netzwerk dieses Compose-Projekts.
import { existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { Pool } from 'pg';
import { logged } from '../core/log.js';
import { type CommandExecutor, type CommandResult, redactOutput, runCommand } from '../core/command.js';
import {
  dockerClientEnvironment,
  SANDBOX_NETWORK,
  sandboxBadge,
  sandboxExecutor,
  sandboxMode,
  sandboxOffWarning,
  type SandboxMode,
  usesSandbox,
} from '../core/sandbox.js';
import { composeViolation } from '../agent/compose-check.js';
import { COMPOSE_FILES } from '../agent/service-actions.js';
import { agentComposeProject } from './project-command.js';

/** Label eines Compose-Dienstes, den die Projekttests brauchen (z. B. `labels: { aideation.test: "true" }`). */
export const TEST_SERVICE_LABEL = 'aideation.test';
const COMPOSE_TIMEOUT_MS = 10 * 60_000;

/** Sandbox-Schalter des Projekts (projects.agent_sandbox); null = es gilt der globale Schalter. */
export async function projectSandbox(pool: Pick<Pool, 'query'>, project: string): Promise<string | null> {
  try {
    const { rows } = await pool.query<{ mode: string | null }>(
      'SELECT agent_sandbox AS mode FROM projects WHERE slug = $1',
      [project],
    );
    return rows[0]?.mode ?? null;
  } catch (error) {
    // Ohne lesbaren Projektwert gilt der globale Schalter (DEV_LOG_AGENT_SANDBOX).
    logged(`agent-sandbox:${project}`)(error);
    return null;
  }
}

/** Text fürs Worker-Badge: Problem der Sandbox (Docker, Image, Netzwerk) oder die Warnung des Notfallmodus „off“. */
export async function sandboxStatus(pool: Pick<Pool, 'query'>, project: string): Promise<string | null> {
  return sandboxBadge(project) ?? sandboxOffWarning(sandboxMode(await projectSandbox(pool, project)));
}

interface ComposeConfig {
  services?: Record<
    string,
    { labels?: Record<string, string> | string[]; networks?: Record<string, unknown> | string[] }
  >;
  networks?: Record<string, { name?: string } | null>;
}

const truthy = (value: unknown): boolean => /^(?:true|1|yes|ja)$/i.test(String(value ?? '').trim());

/** Dienste mit dem Label aideation.test (Labels als Objekt oder als Liste „name=wert“). */
export function testServices(config: ComposeConfig): string[] {
  return Object.entries(config.services ?? {})
    .filter(([, service]) => {
      const labels = service.labels;
      if (Array.isArray(labels))
        return labels.some((entry) => {
          const [key, value = 'true'] = String(entry).split('=');
          return key === TEST_SERVICE_LABEL && truthy(value);
        });
      return truthy(labels?.[TEST_SERVICE_LABEL]);
    })
    .map(([name]) => name)
    .sort();
}

/** Netzwerk der Testdienste: erstes Netzwerk des ersten Dienstes, sonst das Standardnetz des Compose-Projekts. */
export function testNetwork(config: ComposeConfig, services: string[], composeProject: string): string {
  const service = config.services?.[services[0] ?? ''];
  const networks = Array.isArray(service?.networks) ? service.networks : Object.keys(service?.networks ?? {});
  const key = networks[0] ?? 'default';
  return config.networks?.[key]?.name ?? `${composeProject}_${key}`;
}

/** Compose-Datei im Projektordner (echter Pfad innerhalb des Ordners) oder null. */
function composeFile(cwd: string): string | null {
  const root = realpathSync(cwd);
  for (const name of COMPOSE_FILES) {
    const path = resolve(root, name);
    if (!existsSync(path)) continue;
    const real = realpathSync(path);
    return real === root || real.startsWith(root + sep) ? real : null;
  }
  return null;
}

const failing =
  (message: string): CommandExecutor =>
  async (): Promise<CommandResult> => ({ exitCode: 1, durationMs: 0, output: `${message}\n` });

/**
 * Executor für Projekttests im Container. Ohne Testdienste: das interne Agent-Netzwerk (npm nur über den
 * Egress-Proxy). Mit Testdiensten: Compose startet sie (geprüft wie services.up), der Testcontainer hängt nur im
 * Netzwerk des Compose-Projekts. Scheitert das, scheitern die Tests mit Meldung – nichts läuft auf dem Host.
 */
export async function projectTestExecutor(options: {
  project: string;
  cwd: string;
  runId: string;
  docker?: CommandExecutor;
  mode?: SandboxMode;
}): Promise<CommandExecutor> {
  const docker = options.docker ?? runCommand;
  const sandbox = { runId: options.runId, project: options.project, docker };
  // Arbeitscontainer: Testdienste stehen in .aideation/workbench.json, Docker gibt es im Stapel selbst.
  if (options.mode === 'workbench') return sandboxExecutor(options.cwd, { ...sandbox, mode: 'workbench' });
  const file = existsSync(options.cwd) ? composeFile(options.cwd) : null;
  if (!file) return sandboxExecutor(options.cwd, { ...sandbox, network: SANDBOX_NETWORK });
  // Wie bei services.up: das Compose-Projekt der Agent-Kopie (<projekt>-agent), nie das der Live-Container.
  const composeProject =
    agentComposeProject(options.cwd) ?? `${options.project.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}-test`;
  const base = ['docker', 'compose', '-f', file, '-p', composeProject];
  const env = dockerClientEnvironment();
  const config = await docker([...base, 'config', '--format', 'json'], options.cwd, {
    timeoutMs: COMPOSE_TIMEOUT_MS,
    env,
  }).catch((error: unknown) => ({ exitCode: 1, durationMs: 0, output: String(error) }));
  if (config.exitCode !== 0) {
    return failing(
      `Sandbox: Compose-Konfiguration des Projekts nicht lesbar – Tests nicht gestartet. ${redactOutput(config.output, process.env).slice(-400)}`,
    );
  }
  let parsed: ComposeConfig;
  try {
    parsed = JSON.parse(config.output.slice(config.output.indexOf('{'))) as ComposeConfig;
  } catch {
    return failing('Sandbox: Compose-Konfiguration des Projekts ist kein gültiges JSON – Tests nicht gestartet.');
  }
  const services = testServices(parsed);
  if (!services.length) return sandboxExecutor(options.cwd, { ...sandbox, network: SANDBOX_NETWORK });
  const violation = composeViolation(config.output, realpathSync(options.cwd));
  if (violation) return failing(`Sandbox: Testdienste abgelehnt – ${violation}`);
  const up = await docker([...base, 'up', '-d', '--wait', ...services], options.cwd, {
    timeoutMs: COMPOSE_TIMEOUT_MS,
    env,
  }).catch((error: unknown) => ({ exitCode: 1, durationMs: 0, output: String(error) }));
  if (up.exitCode !== 0) {
    return failing(
      `Sandbox: Testdienste (${services.join(', ')}) starten nicht – Tests nicht gestartet. ${redactOutput(up.output, process.env).slice(-400)}`,
    );
  }
  return sandboxExecutor(options.cwd, { ...sandbox, network: testNetwork(parsed, services, composeProject) });
}

/**
 * Executor fürs Test-Gate und den Komplettlauf eines Projekts: mit Sandbox (Standard) der Testcontainer, im
 * Notfallmodus (DEV_LOG_AGENT_SANDBOX=off) der übergebene Host-Executor.
 */
export async function gateExecutor(
  pool: Pick<Pool, 'query'>,
  project: string,
  cwd: string,
  host: CommandExecutor,
  runId: string,
): Promise<CommandExecutor> {
  const mode = sandboxMode(await projectSandbox(pool, project));
  if (!usesSandbox(mode)) return host;
  return projectTestExecutor({ project, cwd, runId, docker: host, mode });
}
