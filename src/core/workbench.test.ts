import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CommandExecutor, CommandResult } from './command.js';
import { EGRESS_CONTAINER, resetAgentNetwork, runInSandbox, SANDBOX_NETWORK } from './sandbox.js';
import {
  mainCheckout,
  parseWorkbenchExtras,
  resetWorkbenches,
  runInWorkbench,
  stopLeftoverWorkbenchRuns,
  WORKBENCH_DOCKER_HOST,
  workbenchCompose,
  workbenchContainer,
  workbenchExecArgs,
  workbenchHash,
  workbenchName,
} from './workbench.js';

const TOKEN = 'sk-ant-oat01-geheimer-test-token-1234567890';
const ok = (output = ''): CommandResult => ({ exitCode: 0, durationMs: 1, output });

interface Service {
  privileged?: boolean;
  network_mode?: string;
  volumes?: string[];
  cap_drop?: string[];
  environment?: Record<string, string>;
  ports?: unknown;
  labels?: Record<string, string>;
}

function fixture(): { root: string; worktree: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'aideation-workbench-'));
  const worktree = join(root, 'agent');
  mkdirSync(worktree);
  return { root, worktree, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Docker-Attrappe: Netzwerk intern, Proxy läuft, Stapel fehlt (inspect scheitert) – sonst Erfolg. */
function fakeDocker(answer: (command: string[]) => CommandResult | null = () => null): {
  calls: string[][];
  docker: CommandExecutor;
} {
  const calls: string[][] = [];
  const docker: CommandExecutor = async (command) => {
    calls.push(command);
    const own = answer(command);
    if (own) return own;
    if (command[1] === 'network' && command[2] === 'inspect') return ok('true\n');
    if (command[1] === 'inspect' && command.includes(EGRESS_CONTAINER)) return ok('true\n');
    if (command[1] === 'inspect') return { exitCode: 1, durationMs: 1, output: 'No such object' };
    if (command[1] === 'version') return ok('29');
    return ok();
  };
  return { calls, docker };
}

test('Arbeitscontainer: nur der Docker-Dienst ist privilegiert, alle teilen den Namensraum der workbench', () => {
  const compose = workbenchCompose('/srv/demo/agent', {
    project: 'Demo',
    platform: 'darwin',
    uid: 501,
    gid: 20,
    extras: parseWorkbenchExtras(
      JSON.stringify({
        services: { postgres: { image: 'postgres:17-alpine', command: ['-p', '5433'] } },
        environment: { DEV_LOG_DATABASE_URL: 'postgresql://t:t@127.0.0.1:5433/t' },
      }),
    ),
  }) as { services: Record<string, Service>; networks: Record<string, { name: string; external: boolean }> };
  const { workbench, docker, postgres } = compose.services;
  assert.ok(workbench && docker && postgres);
  assert.equal(workbench.privileged, undefined);
  assert.deepEqual(workbench.cap_drop, ['ALL']);
  assert.deepEqual(workbench.volumes, [
    '/srv/demo/agent:/workspace',
    'aideation-node-modules-demo:/workspace/node_modules',
  ]);
  assert.equal(workbench.environment?.DOCKER_HOST, WORKBENCH_DOCKER_HOST);
  assert.equal(workbench.environment?.DEV_LOG_DATABASE_URL, 'postgresql://t:t@127.0.0.1:5433/t');
  assert.equal((workbench as { container_name?: string }).container_name, 'agents_demo_workbench');
  assert.equal((postgres as { container_name?: string }).container_name, 'agents_demo_postgres');
  assert.equal(docker.privileged, true);
  assert.equal(docker.network_mode, 'service:workbench');
  assert.ok(
    !JSON.stringify((compose.services.docker as { command?: string[] }).command).includes('0.0.0.0'),
    'Docker lauscht nicht im Agent-Netzwerk (nur 127.0.0.1 und Socket)',
  );
  assert.ok(docker.volumes?.includes('/srv/demo/agent:/workspace'), 'gleicher Pfad für Bind-Mounts der Agents');
  assert.ok(!docker.volumes?.some((volume) => volume.includes('docker.sock')), 'nie der Socket des Hosts');
  assert.equal(postgres.network_mode, 'service:workbench');
  const start = (workbench as { command?: string[] }).command?.join(' ') ?? '';
  assert.ok(start.includes('$$HOME') && !/[^$]\$HOME/.test(start), 'Compose ersetzt kein $ des Startbefehls');
  assert.equal(postgres.privileged, undefined);
  assert.equal(compose.networks.agents?.name, SANDBOX_NETWORK);
  assert.equal(compose.networks.agents?.external, true);
  const text = JSON.stringify(compose);
  assert.ok(!text.includes('.ssh') && !text.includes(TOKEN));
  const mounts = Object.values(compose.services).flatMap((service) => service.volumes ?? []);
  assert.ok(!mounts.some((mount) => mount.includes('docker.sock')), 'kein Docker-Socket des Rechners eingebunden');
});

test('Arbeitscontainer: workbench.json erlaubt nur Image, Umgebung, Befehl und tmpfs', () => {
  const extras = parseWorkbenchExtras(
    JSON.stringify({ services: { db: { image: 'postgres:17-alpine', tmpfs: ['/var/lib/postgresql/data'] } } }),
  );
  assert.equal(extras.services.db?.image, 'postgres:17-alpine');
  const refused = [
    { services: { db: { image: 'postgres', privileged: true } } },
    { services: { db: { image: 'postgres', ports: ['5432:5432'] } } },
    { services: { db: { image: 'postgres', volumes: ['/:/host'] } } },
    { services: { db: { image: 'postgres', network_mode: 'host' } } },
    { services: { docker: { image: 'docker:dind' } } },
    { services: { workbench: { image: 'evil' } } },
    { services: { db: { image: 'postgres; rm -rf /' } } },
    { services: { db: { image: 'postgres', tmpfs: ['../../etc'] } } },
    { environment: { 'BAD-NAME': 'x' } },
  ];
  for (const config of refused)
    assert.throws(() => parseWorkbenchExtras(JSON.stringify(config)), JSON.stringify(config));
});

test('Arbeitscontainer: Namen je Projekt, Hash ändert sich mit der Konfiguration', () => {
  assert.equal(workbenchName('Mainty'), 'agents_mainty');
  assert.equal(workbenchContainer('Mainty'), 'agents_mainty_workbench');
  assert.equal(workbenchContainer('dev-log', 'postgres'), 'agents_dev-log_postgres');
  const moved = workbenchCompose('/a/source', { project: 'mainty', platform: 'darwin', uid: 1, gid: 1 });
  const base = workbenchCompose('/a/agent', { project: 'mainty', platform: 'darwin', uid: 1, gid: 1 });
  const other = workbenchCompose('/a/agent', { project: 'mainty', platform: 'darwin', uid: 1, gid: 1, memory: '8g' });
  assert.notEqual(workbenchHash(base), workbenchHash(other));
  const rebuilt = workbenchCompose('/a/agent', {
    project: 'mainty',
    platform: 'darwin',
    uid: 1,
    gid: 1,
    imageId: 'sha256:neu',
  });
  assert.notEqual(workbenchHash(base), workbenchHash(rebuilt), 'neues Image: Stapel neu erstellen');
  assert.notEqual(workbenchHash(base), workbenchHash(moved), 'anderer Arbeitsordner: Stapel neu erstellen');
});

test('Arbeitscontainer: workbench.json kommt aus dem Haupt-Checkout, nicht aus dem Worktree des Agents', () => {
  const { root, worktree, cleanup } = fixture();
  try {
    assert.equal(mainCheckout(worktree), worktree, 'ohne .git: der Ordner selbst');
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(root, 'source')}/.git/worktrees/agent\n`);
    assert.equal(mainCheckout(worktree), join(root, 'source'));
  } finally {
    cleanup();
  }
});

test('Arbeitscontainer: docker exec mit Anmeldung nur als Name und eigener Prozessgruppe', () => {
  const args = workbenchExecArgs(['/Users/dev/.local/bin/claude', '-p', 'x'], '/srv/demo/agent', {
    project: 'demo',
    runId: 'r1',
    cwd: '/srv/demo/agent/frontend',
    platform: 'darwin',
    uid: 501,
    gid: 20,
    environment: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
  });
  assert.equal(args[1], 'exec');
  assert.equal(args[args.indexOf('-w') + 1], '/workspace/frontend');
  assert.ok(args.includes('CLAUDE_CODE_OAUTH_TOKEN'));
  assert.ok(!args.join(' ').includes(TOKEN));
  assert.ok(args.includes('setsid'));
  assert.deepEqual(args.slice(-3), ['claude', '-p', 'x']);
});

test('Arbeitscontainer: startet den Stapel, installiert einmal und führt dann den Befehl aus', async () => {
  resetAgentNetwork();
  resetWorkbenches();
  const { root, worktree, cleanup } = fixture();
  const previous = process.env.DEV_LOG_WORKBENCH_DIR;
  process.env.DEV_LOG_WORKBENCH_DIR = join(root, 'compose');
  try {
    writeFileSync(join(worktree, 'package.json'), '{"name":"demo"}');
    const { calls, docker } = fakeDocker();
    const result = await runInSandbox(['npm', 'test'], worktree, {
      runId: 'r2',
      project: 'demo',
      docker,
      mode: 'workbench',
      environment: {},
    });
    assert.equal(result.exitCode, 0, result.output);
    const up = calls.find((call) => call.includes('compose') && call.includes('up'));
    assert.ok(up, 'docker compose up');
    const execs = calls.filter((call) => call[1] === 'exec' && call.includes('setsid'));
    assert.equal(execs.length, 2);
    assert.match(execs[0]!.at(-1) ?? '', /npm install --ignore-scripts/);
    assert.deepEqual(execs[1]!.slice(-2), ['npm', 'test']);
    assert.ok(!calls.some((call) => call[1] === 'run' && call.includes('--cap-drop')), 'kein Wegwerf-Container');
  } finally {
    if (previous === undefined) delete process.env.DEV_LOG_WORKBENCH_DIR;
    else process.env.DEV_LOG_WORKBENCH_DIR = previous;
    cleanup();
  }
});

test('Arbeitscontainer: nach dem Gate im Ordner der Menschen startet der nächste Agent-Lauf wieder seinen Worktree', async () => {
  resetAgentNetwork();
  resetWorkbenches();
  const { root, worktree, cleanup } = fixture();
  const source = join(root, 'source');
  mkdirSync(source);
  const previous = process.env.DEV_LOG_WORKBENCH_DIR;
  process.env.DEV_LOG_WORKBENCH_DIR = join(root, 'compose');
  try {
    const { calls, docker } = fakeDocker();
    const run = (directory: string, runId: string) =>
      runInSandbox(['npm', 'test'], directory, { runId, project: 'demo', docker, mode: 'workbench', environment: {} });
    await run(worktree, 'agent-1');
    await run(source, 'gate');
    await run(worktree, 'agent-2');
    const ups = calls.filter((call) => call.includes('compose') && call.includes('up'));
    assert.equal(ups.length, 3, 'der Stapel wird für den Agent-Worktree erneut erstellt, nicht aus dem Cache genommen');
  } finally {
    if (previous === undefined) delete process.env.DEV_LOG_WORKBENCH_DIR;
    else process.env.DEV_LOG_WORKBENCH_DIR = previous;
    cleanup();
  }
});

test('Arbeitscontainer: beim Start werden Läufe des Vorgängers in den Containern beendet', async () => {
  const { calls, docker } = fakeDocker((command) => {
    if (command[1] === 'ps') return ok('agents_demo_workbench\nagents_demo_docker\nagents_demo_db\n');
    if (command[1] === 'exec') return ok('2\n');
    return null;
  });
  const stopped = await stopLeftoverWorkbenchRuns(docker, tmpdir());
  assert.equal(stopped, 2);
  const execs = calls.filter((call) => call[1] === 'exec');
  assert.deepEqual(
    execs.map((call) => call[2]),
    ['agents_demo_workbench'],
    'nur die workbench, nicht docker oder Zusatzdienste',
  );
  const script = execs[0]!.at(-1)!;
  assert.match(script, /\/tmp\/aideation-run-\*\.pid/);
  assert.match(script, /kill -TERM -"\$p"/);
  assert.match(script, /kill -KILL -"\$p"/);
  assert.match(script, /\[ "\$p" -gt 1 \] \|\| continue/, 'nie Gruppe 1 (hält den Container)');
});

test('Arbeitscontainer: Aufräumen beim Start ohne Docker tut nichts', async () => {
  const { docker } = fakeDocker((command) =>
    command[1] === 'ps' ? { exitCode: 1, durationMs: 1, output: 'Cannot connect' } : null,
  );
  assert.equal(await stopLeftoverWorkbenchRuns(docker, tmpdir()), 0);
});

test('Arbeitscontainer: lesende Läufe bleiben kurzlebige Container mit :ro', async () => {
  resetAgentNetwork();
  const { worktree, cleanup } = fixture();
  try {
    const { calls, docker } = fakeDocker();
    await runInSandbox(['claude', '-p', 'x'], worktree, {
      runId: 'r3',
      project: 'demo',
      docker,
      mode: 'workbench',
      readOnly: true,
      environment: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
    });
    const run = calls.find((call) => call[1] === 'run' && call.includes('--cap-drop'));
    assert.ok(run, 'docker run');
    assert.ok(run.some((part) => part.endsWith(':/workspace:ro')));
    assert.ok(!calls.some((call) => call.includes('compose')));
  } finally {
    cleanup();
  }
});

test('Arbeitscontainer: Abbruch beendet die Prozessgruppe im Container', async () => {
  resetAgentNetwork();
  resetWorkbenches();
  const { root, worktree, cleanup } = fixture();
  const previous = process.env.DEV_LOG_WORKBENCH_DIR;
  process.env.DEV_LOG_WORKBENCH_DIR = join(root, 'compose');
  const controller = new AbortController();
  try {
    const { calls, docker } = fakeDocker((command) => {
      if (command[1] === 'exec' && command.includes('setsid')) {
        controller.abort();
        return { exitCode: 143, durationMs: 1, output: 'beendet' };
      }
      return null;
    });
    const result = await runInWorkbench(['sleep', '300'], worktree, {
      runId: 'r4',
      project: 'demo',
      docker,
      signal: controller.signal,
      environment: {},
    });
    assert.notEqual(result.exitCode, 0);
    const kill = calls.find((call) => call[1] === 'exec' && call.join(' ').includes('kill -TERM'));
    assert.ok(kill, 'kill der Prozessgruppe');
  } finally {
    if (previous === undefined) delete process.env.DEV_LOG_WORKBENCH_DIR;
    else process.env.DEV_LOG_WORKBENCH_DIR = previous;
    cleanup();
  }
});
