import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CommandExecutor, CommandResult } from '../core/command.js';
import { EGRESS_CONTAINER, resetAgentNetwork, SANDBOX_NETWORK } from '../core/sandbox.js';
import { gateExecutor, projectTestExecutor, sandboxStatus, testNetwork, testServices } from './test-sandbox.js';
import { containerPreviewUrl } from './visual-sandbox.js';

const ok = (output = ''): CommandResult => ({ exitCode: 0, durationMs: 1, output });

function projectFolder(compose?: string): { cwd: string; cleanup: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aideation-test-sandbox-')));
  const cwd = join(root, 'demo', 'agent');
  mkdirSync(cwd, { recursive: true });
  if (compose) writeFileSync(join(cwd, 'compose.yaml'), compose);
  return { cwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Docker-Attrappe mit bereitem Agent-Netzwerk; `config` ist die Antwort auf docker compose config. */
function fakeDocker(config: unknown): { calls: string[][]; docker: CommandExecutor } {
  const calls: string[][] = [];
  const docker: CommandExecutor = async (command) => {
    calls.push(command);
    if (command[1] === 'compose' && command.includes('config')) return ok(JSON.stringify(config));
    if ((command[1] === 'network' && command[2] === 'inspect') || command.includes(EGRESS_CONTAINER)) return ok('true');
    return ok('27');
  };
  return { calls, docker };
}

const networkOf = (calls: string[][]): string | undefined => {
  const run = calls.find((command) => command.includes('--cap-drop'));
  return run?.[run.indexOf('--network') + 1];
};

test('Testdienste: nur Dienste mit Label aideation.test, Netzwerk aus der Compose-Konfiguration', () => {
  const config = {
    services: {
      api: { labels: { other: 'x' } },
      db: { labels: { 'aideation.test': 'true' }, networks: { backend: {} } },
      cache: { labels: ['aideation.test=true'] },
    },
    networks: { backend: { name: 'demo-agent_backend' } },
  };
  assert.deepEqual(testServices(config), ['cache', 'db']);
  assert.equal(testNetwork(config, ['db'], 'demo-agent'), 'demo-agent_backend');
  assert.equal(testNetwork(config, ['cache'], 'demo-agent'), 'demo-agent_default');
});

test('Testcontainer: ohne Testdienste im internen Agent-Netzwerk', async () => {
  resetAgentNetwork();
  const { cwd, cleanup } = projectFolder();
  try {
    const { calls, docker } = fakeDocker({});
    const execute = await projectTestExecutor({ project: 'demo', cwd, runId: 'r1', docker });
    await execute(['npm', 'test'], cwd, {});
    assert.equal(networkOf(calls), SANDBOX_NETWORK);
    assert.ok(!calls.some((command) => command[1] === 'compose'), 'ohne Compose-Datei kein Compose');
  } finally {
    cleanup();
  }
});

test('Testcontainer: Dienste startet der Worker per Compose, der Test hängt nur im Projekt-Netzwerk', async () => {
  const { cwd, cleanup } = projectFolder('services: {}\n');
  try {
    const { calls, docker } = fakeDocker({ services: { db: { labels: { 'aideation.test': 'true' } } } });
    const execute = await projectTestExecutor({ project: 'demo', cwd, runId: 'r2', docker });
    const up = calls.find((command) => command.includes('up'));
    assert.deepEqual(up?.slice(-4), ['up', '-d', '--wait', 'db']);
    assert.ok(up?.includes('demo-agent'), 'Compose-Projekt der Agent-Kopie, nie das Live-Projekt');
    await execute(['npm', 'test'], cwd, {});
    assert.equal(networkOf(calls), 'demo-agent_default');
    const run = calls.find((command) => command.includes('--cap-drop'))!;
    assert.ok(!run.join(' ').includes('PROXY'), 'im Projekt-Netzwerk kein Egress-Proxy');
  } finally {
    cleanup();
  }
});

test('Testcontainer: Testdienste mit Host-Rechten werden abgelehnt, nichts läuft', async () => {
  const { cwd, cleanup } = projectFolder('services: {}\n');
  try {
    const { calls, docker } = fakeDocker({
      services: { db: { labels: { 'aideation.test': 'true' }, network_mode: 'host' } },
    });
    const execute = await projectTestExecutor({ project: 'demo', cwd, runId: 'r3', docker });
    const result = await execute(['npm', 'test'], cwd, {});
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /Testdienste abgelehnt.*Host-Namensraum/);
    assert.ok(!calls.some((command) => command.includes('up') || command.includes('--cap-drop')));
  } finally {
    cleanup();
  }
});

test('Gate: im Notfallmodus „off“ der Host-Executor, sonst der Testcontainer; Badge warnt bei „off“', async () => {
  const host: CommandExecutor = async () => ok('host');
  const pool = (mode: string | null) => ({ query: async () => ({ rows: [{ mode }] }) }) as never;
  assert.equal(await gateExecutor(pool('off'), 'demo', '/nicht/da', host, 'g1'), host);
  assert.notEqual(await gateExecutor(pool('docker'), 'demo', '/nicht/da', host, 'g2'), host);
  assert.match((await sandboxStatus(pool('off'), 'badge-demo')) ?? '', /Notfallmodus/);
  assert.equal(await sandboxStatus(pool('docker'), 'badge-demo'), null);
});

test('Vorschau aus dem Container: localhost des Hosts heisst host.docker.internal', () => {
  assert.equal(containerPreviewUrl('http://localhost:4300'), 'http://host.docker.internal:4300');
  assert.equal(containerPreviewUrl('http://127.0.0.1:8080/app/'), 'http://host.docker.internal:8080/app/');
  assert.equal(containerPreviewUrl('https://review.example.ch'), 'https://review.example.ch');
});
