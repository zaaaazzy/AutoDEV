import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { redactOutput } from '../core/command.js';
import { agentComposeProject } from './runner-prompts.js';

const ROOT = join(import.meta.dirname, '..', '..');
const LIVE_CONTAINERS = [
  'aideation_database_postgres',
  'aideation_backend_nodejs',
  'aideation_frontend_angular',
  'aideation_backup_postgres',
  'aideation_proxy_caddy',
  'aideation_proxy_caddy_volumes',
  'aideation_worker_nodejs',
  'aideation_worker_volumes',
  'aideation_watchdog_nodejs',
];
const LIVE_VOLUMES = [
  'aideation_pgdata',
  'aideation_caddy_data',
  'aideation_caddy_config',
  'aideation_worker_modules',
  'aideation_watchdog_state',
];
const LIVE_PORTS = ['5433', '3100', '80', '443'];

/** Löst ${COMPOSE_PROJECT_NAME:-…} so auf wie Compose für das angegebene Projekt (ohne Docker). */
function resolved(file: string, project: string | undefined): string {
  return readFileSync(join(ROOT, file), 'utf8').replace(
    /\$\{COMPOSE_PROJECT_NAME:-([^}]*)\}/g,
    (_, fallback: string) => project || fallback,
  );
}

/** Docker-Namen (container_name, Volume-name) und die gewählte Port-Datei des Projekts. */
function composeNames(project: string | undefined): { names: string[]; portsFile: string } {
  const compose = resolved('docker-compose.yml', project);
  const names = [...compose.matchAll(/^\s+(?:container_name|name):\s*(\S+)/gm)].map((match) => match[1]);
  const files = new Set([...compose.matchAll(/^\s+file:\s*(\S+)/gm)].map((match) => match[1]));
  assert.equal(files.size, 1, 'alle Dienste holen ihre Host-Ports aus derselben Datei');
  return { names, portsFile: [...files][0] };
}

function publishedPorts(portsFile: string): string[] {
  return [...readFileSync(join(ROOT, portsFile), 'utf8').matchAll(/^\s+-\s*"(?:[\d.]+:)?(\d+):\d+"/gm)].map(
    (match) => match[1],
  );
}

test('Agent-Compose: Projekt aideation-agent teilt keine Container, Volumes oder Host-Ports mit dem Live-Stack', () => {
  const project = agentComposeProject('/Coding/AIdeation/agent');
  assert.equal(project, 'aideation-agent');
  const { names, portsFile } = composeNames(project);
  for (const live of [...LIVE_CONTAINERS, ...LIVE_VOLUMES])
    assert.ok(!names.includes(live), `${live} im Agent-Projekt`);
  assert.ok(
    names.every((name) => name.startsWith('aideation-agent_')),
    names.join(', '),
  );
  assert.ok(existsSync(join(ROOT, portsFile)), `${portsFile} fehlt`);
  assert.deepEqual(publishedPorts(portsFile), [], 'das Agent-Projekt veröffentlicht keine Host-Ports');
});

test('Agent-Compose: docker-compose.yml selbst veröffentlicht keine Ports (nur über die Datei je Projekt)', () => {
  assert.doesNotMatch(readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8'), /^\s+ports:/m);
});

test('Agent-Compose: der Live-Stack behält Namen, Volumes und Ports (mit und ohne COMPOSE_PROJECT_NAME)', () => {
  for (const project of [undefined, 'aideation']) {
    const { names, portsFile } = composeNames(project);
    assert.deepEqual(names.sort(), [...LIVE_CONTAINERS, ...LIVE_VOLUMES].sort());
    assert.deepEqual(publishedPorts(portsFile), LIVE_PORTS);
  }
});

/** `docker compose config` wie im Akzeptanzkriterium; null, wenn Docker fehlt (Test wird übersprungen). */
function dockerConfig(project: string | undefined): string | null {
  // Alle Profile aktiv, damit jeder Dienst geprüft wird; nur docker-compose.yml (eine erzeugte
  // docker-compose.override.yml mit Pfaden dieses Rechners gehört nicht in den Vergleich).
  const env: NodeJS.ProcessEnv = { ...process.env, COMPOSE_PROFILES: 'https,worker' };
  delete env.COMPOSE_PROJECT_NAME;
  delete env.COMPOSE_FILE;
  if (project) env.COMPOSE_PROJECT_NAME = project;
  const result = spawnSync('docker', ['compose', '-f', 'docker-compose.yml', 'config', '--format', 'json'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    if (result.error || /unknown|not a docker command|Cannot connect/i.test(result.stderr)) return null;
    // Aufgelöste Konfiguration kann Passwörter aus der .env enthalten: nur bereinigt ausgeben.
    assert.fail(`docker compose config scheitert: ${redactOutput(result.stderr, env)}`);
  }
  return result.stdout;
}

test('Agent-Compose: docker compose config für aideation-agent enthält keine Live-Namen oder Live-Ports', (t) => {
  const output = dockerConfig('aideation-agent');
  if (output === null) return t.skip('docker compose nicht verfügbar');
  const config = JSON.parse(output) as {
    name: string;
    services: Record<string, { container_name?: string; ports?: unknown[] }>;
    volumes: Record<string, { name?: string }>;
  };
  assert.equal(config.name, 'aideation-agent');
  for (const [service, definition] of Object.entries(config.services)) {
    assert.ok(!LIVE_CONTAINERS.includes(definition.container_name ?? ''), `${service}: ${definition.container_name}`);
    assert.equal(definition.ports, undefined, `${service} veröffentlicht Host-Ports`);
  }
  for (const volume of Object.values(config.volumes)) assert.ok(!LIVE_VOLUMES.includes(volume.name ?? ''));
});

test('Agent-Compose: docker compose config im Quellordner behält die Live-Namen und -Ports', (t) => {
  const output = dockerConfig(undefined);
  if (output === null) return t.skip('docker compose nicht verfügbar');
  const config = JSON.parse(output) as {
    services: Record<string, { container_name?: string; ports?: { published?: string }[] }>;
    volumes: Record<string, { name?: string }>;
  };
  assert.deepEqual(
    Object.values(config.services)
      .map((service) => service.container_name)
      .sort(),
    [...LIVE_CONTAINERS].sort(),
  );
  assert.deepEqual(
    Object.values(config.volumes)
      .map((volume) => volume.name)
      .sort(),
    [...LIVE_VOLUMES].sort(),
  );
  const ports = Object.values(config.services).flatMap((service) => (service.ports ?? []).map((p) => p.published));
  assert.deepEqual(ports.sort(), [...LIVE_PORTS].sort());
});
