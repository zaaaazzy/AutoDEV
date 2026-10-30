import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CommandExecutor, CommandResult } from './command.js';
import { guardHookCommand, withAgentPermissions } from '../agent/tool-permissions.js';
import {
  containerDirectory,
  credentialProblem,
  DOCKER_HUB_HOSTS,
  DEPENDENCY_STAMP,
  dependencyCommand,
  dependencyStamp,
  dockerClientEnvironment,
  dockerHostPath,
  EGRESS_CONTAINER,
  EGRESS_URL,
  egressAllowList,
  egressRunArgs,
  ensureAgentNetwork,
  modulesVolume,
  readOnlyWorkspace,
  removeLeftoverContainers,
  resetAgentNetwork,
  runInSandbox,
  SANDBOX_GUARD,
  SANDBOX_NETWORK,
  SANDBOX_NO_PROXY,
  sandboxBadge,
  sandboxExecutor,
  sandboxFailureNote,
  sandboxMode,
  sandboxOffWarning,
  sandboxRunArgs,
  SANDBOX_WORKDIR,
  usesSandbox,
} from './sandbox.js';
import { READ_ONLY_ROLES } from '../agent/permission-rules.js';
import { usageLimitReset } from '../runner/autofix.js';

const TOKEN = 'sk-ant-oat01-geheimer-test-token-1234567890';
const WORKTREE = '/srv/projekte/demo/agent';

const ok = (output = ''): CommandResult => ({ exitCode: 0, durationMs: 1, output });

/** Agent-Netzwerk ist intern, der Egress-Proxy läuft: Standardantwort der Attrappe für diese Abfragen. */
const networkReady = (command: string[]): CommandResult | null =>
  (command[1] === 'network' && command[2] === 'inspect') ||
  (command[1] === 'inspect' && command.includes(EGRESS_CONTAINER))
    ? ok('true\n')
    : null;

/** Docker-Attrappe: zeichnet jeden Aufruf auf; `answer` bestimmt das Ergebnis je Unterbefehl. */
function fakeDocker(answer: (command: string[]) => CommandResult | Promise<CommandResult> = () => ok()): {
  calls: { command: string[]; env?: NodeJS.ProcessEnv }[];
  docker: CommandExecutor;
} {
  const calls: { command: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const docker: CommandExecutor = async (command, _cwd, options) => {
    calls.push({ command, env: options?.env });
    return networkReady(command) ?? answer(command);
  };
  return { calls, docker };
}

const args = (environment: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }) =>
  sandboxRunArgs(['/Users/dev/.local/bin/claude', '-p', 'Auftrag'], WORKTREE, {
    runId: 'run-1',
    project: 'demo',
    name: 'aideation-run-1-abc',
    platform: 'darwin',
    uid: 501,
    gid: 20,
    environment,
  });

test('Sandbox: docker run mit --rm, ohne Capabilities, no-new-privileges, Limits und Label', () => {
  const command = args();
  const joined = command.join(' ');
  assert.deepEqual(command.slice(0, 3), ['docker', 'run', '--rm']);
  assert.match(joined, /--cap-drop ALL/);
  assert.match(joined, /--security-opt no-new-privileges/);
  assert.match(joined, /--user 501:20/);
  assert.match(joined, /--cpus \S+/);
  assert.match(joined, /--memory \S+/);
  assert.match(joined, /--label aideation\.run=run-1/);
  assert.ok(!command.includes('--privileged'));
  // Im Image heisst die CLI „claude“; der Host-Pfad gehört nicht in den Container.
  assert.deepEqual(command.slice(-3), ['claude', '-p', 'Auftrag']);
});

test('Sandbox: nur Worktree und node_modules-Volume, kein Socket, ~/.ssh, ~/.claude oder Home', () => {
  const command = args();
  const mounts = command.flatMap((part, index) =>
    command[index - 1] === '-v' || command[index - 1] === '--mount' || command[index - 1] === '--volume' ? [part] : [],
  );
  assert.deepEqual(mounts, [
    `${WORKTREE}:${SANDBOX_WORKDIR}`,
    `${modulesVolume('demo')}:${SANDBOX_WORKDIR}/node_modules`,
  ]);
  const joined = command.join(' ');
  for (const forbidden of ['docker.sock', '.ssh', '.claude', '--env-file', '.env']) {
    assert.ok(!joined.includes(forbidden), `kein ${forbidden}`);
  }
  for (const mount of mounts) {
    const source = mount.split(':')[0];
    assert.notEqual(source, homedir(), 'nicht das Home-Verzeichnis');
    assert.notEqual(source, '/', 'nicht das Dateisystem des Hosts');
  }
  assert.ok(!command.includes('--volumes-from'));
});

test('Sandbox: Token nur als Name (-e NAME), nie als Wert in den Argumenten', () => {
  const command = args({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: '' });
  assert.ok(!command.join(' ').includes(TOKEN));
  const index = command.indexOf('CLAUDE_CODE_OAUTH_TOKEN');
  assert.equal(command[index - 1], '-e');
  assert.ok(!command.includes('ANTHROPIC_API_KEY'), 'leere Anmeldedaten werden nicht weitergereicht');
  // Der Docker-Client hat den Wert in seiner Umgebung, sonst nichts aus dem Worker.
  const env = dockerClientEnvironment({
    PATH: '/usr/bin',
    CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
    DEV_LOG_SECRET_KEY: 'x'.repeat(32),
    GITHUB_TOKEN: 'ghp_x',
  });
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CODE_OAUTH_TOKEN', 'PATH']);
});

test('Sandbox: Agent-Netzwerk mit Egress-Proxy; Ollama über host.docker.internal', () => {
  const mac = args();
  const joined = mac.join(' ');
  assert.equal(mac[mac.indexOf('--network') + 1], SANDBOX_NETWORK);
  assert.match(joined, /-e DEV_LOG_OLLAMA_URL=http:\/\/host\.docker\.internal:11434/);
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'npm_config_https_proxy'])
    assert.ok(mac.includes(`${name}=${EGRESS_URL}`), `${name} zeigt auf den Egress-Proxy`);
  assert.ok(!joined.includes('--add-host'), 'im internen Netzwerk kein Weg zum Host');
  assert.ok(!mac.includes('host'), 'nie --network host');
  // Testcontainer im Compose-Netzwerk des Projekts: ohne Proxy, unter Linux mit host-gateway.
  const linux = sandboxRunArgs(['npm', 'test'], WORKTREE, {
    runId: 'r',
    project: 'demo',
    name: 'n',
    platform: 'linux',
    uid: 1000,
    gid: 1000,
    environment: {},
    network: 'demo-agent_default',
  });
  assert.equal(linux[linux.indexOf('--network') + 1], 'demo-agent_default');
  assert.ok(!linux.join(' ').includes('PROXY'));
  assert.match(linux.join(' '), /--add-host host\.docker\.internal:host-gateway/);
});

test('Sandbox: lesende Rollen binden Workspace und node_modules nur mit :ro ein', () => {
  for (const role of [...READ_ONLY_ROLES, 'visionary', 'analyst', 'pre_sprint']) {
    assert.equal(readOnlyWorkspace(role), true, role);
    const command = sandboxRunArgs(['claude', '-p', 'x'], WORKTREE, {
      runId: 'r',
      project: 'demo',
      name: 'n',
      platform: 'darwin',
      uid: 501,
      gid: 20,
      environment: {},
      readOnly: readOnlyWorkspace(role),
    });
    const mounts = command.flatMap((part, index) => (command[index - 1] === '-v' ? [part] : []));
    assert.deepEqual(mounts, [
      `${WORKTREE}:${SANDBOX_WORKDIR}:ro`,
      `${modulesVolume('demo')}:${SANDBOX_WORKDIR}/node_modules:ro`,
    ]);
  }
  for (const role of ['developer', 'tester', 'reviewer', 'documenter', 'assistant']) {
    assert.equal(readOnlyWorkspace(role), false, role);
    const mounts = args().flatMap((part, index, all) => (all[index - 1] === '-v' ? [part] : []));
    assert.ok(
      mounts.every((mount) => !mount.endsWith(':ro')),
      `${role} schreibt im Worktree`,
    );
  }
});

test('Sandbox: Egress-Proxy ohne Rechte am Bridge-Netz, Allowlist nur Anthropic, npm, Ollama und Docker Hub', () => {
  const command = egressRunArgs('darwin', { DEV_LOG_AGENT_SANDBOX_EGRESS: 'pypi.org:443, 10.0.0.1:5432x, ;rm' });
  const joined = command.join(' ');
  assert.match(joined, /--cap-drop ALL/);
  assert.match(joined, /--read-only/);
  assert.equal(command[command.indexOf('--network') + 1], 'bridge');
  assert.ok(!command.includes('-v'), 'keine Mounts');
  const allow = command
    .find((part) => part.startsWith('AIDEATION_EGRESS_ALLOW='))!
    .split('=')[1]!
    .split(',');
  assert.deepEqual(allow, [
    'api.anthropic.com:443',
    'registry.npmjs.org:443',
    'host.docker.internal:11434',
    ...DOCKER_HUB_HOSTS,
    'pypi.org:443',
  ]);
  assert.deepEqual(DOCKER_HUB_HOSTS, [
    'registry-1.docker.io:443',
    'auth.docker.io:443',
    'production.cloudflare.docker.com:443',
    'production.cloudfront.docker.com:443',
  ]);
  assert.ok(!egressAllowList({}).includes('5432') && !egressAllowList({}).includes('5433'), 'keine Datenbank');
});

test('Sandbox: Agent-Netzwerk wird intern angelegt, ein nicht internes sperrt den Lauf', async () => {
  resetAgentNetwork();
  const created: string[][] = [];
  const fresh: CommandExecutor = async (command) => {
    created.push(command);
    if (command[1] === 'network' && command[2] === 'inspect')
      return { exitCode: 1, durationMs: 1, output: 'No such network' };
    if (command[1] === 'inspect') return { exitCode: 1, durationMs: 1, output: 'No such object' };
    return ok();
  };
  assert.equal(await ensureAgentNetwork(fresh, { platform: 'darwin' }), null);
  const create = created.find((command) => command[2] === 'create');
  assert.ok(create?.includes('--internal'), 'Netzwerk ist --internal');
  assert.ok(created.some((command) => command[1] === 'run' && command.includes(EGRESS_CONTAINER)));
  assert.ok(
    created.some((command) => command.join(' ') === `docker network connect ${SANDBOX_NETWORK} ${EGRESS_CONTAINER}`),
  );
  resetAgentNetwork();
  const open: CommandExecutor = async (command) =>
    command[1] === 'network' && command[2] === 'inspect' ? ok('false\n') : ok();
  assert.match((await ensureAgentNetwork(open)) ?? '', /nicht intern/);
  resetAgentNetwork();
});

test('Sandbox: Windows-Pfade im Format von Docker Desktop, ohne --user', () => {
  assert.equal(dockerHostPath('C:\\Users\\dev\\projekt-agents', 'win32'), '/c/Users/dev/projekt-agents');
  assert.equal(dockerHostPath('D:\\', 'win32'), '/d');
  assert.equal(dockerHostPath('/srv/projekt', 'linux'), '/srv/projekt');
  const command = sandboxRunArgs(['claude.exe', '-p', 'x'], 'C:\\Users\\dev\\agent', {
    runId: 'r',
    project: 'demo',
    name: 'n',
    platform: 'win32',
    environment: {},
  });
  assert.ok(!command.includes('--user'));
  assert.ok(command.includes(`/c/Users/dev/agent:${SANDBOX_WORKDIR}`));
  assert.deepEqual(command.slice(-3), ['claude', '-p', 'x']);
});

test('Sandbox: Arbeitsordner innerhalb des Worktrees wird auf /workspace abgebildet', () => {
  assert.equal(containerDirectory(WORKTREE, `${WORKTREE}/frontend`), '/workspace/frontend');
  assert.equal(containerDirectory(WORKTREE, WORKTREE), '/workspace');
  assert.equal(containerDirectory(WORKTREE, '/etc'), '/workspace', 'ausserhalb: nur /workspace');
  assert.equal(modulesVolume('Mein Projekt/../x'), 'aideation-node-modules-mein-projekt-..-x');
});

test('Sandbox: Schalter global und je Projekt, Standard Arbeitscontainer, „off“ nur als Notfallmodus mit Warnung', () => {
  assert.equal(sandboxMode(null, {}), 'workbench', 'Standard: Arbeitscontainer');
  assert.equal(sandboxMode(null, { DEV_LOG_AGENT_SANDBOX: 'docker' }), 'docker');
  assert.equal(sandboxMode('workbench', { DEV_LOG_AGENT_SANDBOX: 'off' }), 'workbench');
  assert.equal(usesSandbox('workbench'), true);
  assert.equal(sandboxMode(null, { DEV_LOG_AGENT_SANDBOX: 'off' }), 'off');
  assert.equal(sandboxMode('off', { DEV_LOG_AGENT_SANDBOX: 'docker' }), 'off', 'Projekt geht vor');
  assert.equal(sandboxMode('docker', { DEV_LOG_AGENT_SANDBOX: 'off' }), 'docker');
  assert.equal(sandboxMode(null, { DEV_LOG_AGENT_SANDBOX: 'podman' }), 'workbench', 'unbekannter Wert: Standard');
  assert.equal(sandboxMode(null, { NODE_TEST_CONTEXT: 'child' }), 'off', 'Unit-Tests: Attrappen statt Docker');
  assert.equal(sandboxMode(null, { NODE_TEST_CONTEXT: 'child', DEV_LOG_AGENT_SANDBOX: 'docker' }), 'docker');
  assert.equal(usesSandbox('docker'), true);
  assert.equal(usesSandbox('off'), false);
  assert.match(sandboxOffWarning('off') ?? '', /Notfallmodus.*auf dem Host/);
  assert.equal(sandboxOffWarning('docker'), null);
});

test('Sandbox: Wächter-Hook zeigt im Container auf den gebündelten Wächter und /workspace', () => {
  const hook = guardHookCommand({ create: true, edit: true, scopes: [], root: SANDBOX_WORKDIR }, SANDBOX_GUARD);
  assert.ok(hook);
  assert.match(hook, /^'node' '\/opt\/aideation\/agent-guard\.mjs' '[\w-]+' \|\| exit 2$/);
  const encoded = /'([\w-]+)' \|\|/.exec(hook)?.[1] ?? '';
  assert.equal(JSON.parse(Buffer.from(encoded, 'base64url').toString()).root, SANDBOX_WORKDIR);
  const command = withAgentPermissions(
    ['claude', '-p'],
    'developer',
    { enabled: null, custom: [] },
    null,
    [],
    [],
    SANDBOX_WORKDIR,
    SANDBOX_GUARD,
  );
  const settings = JSON.parse(command[command.indexOf('--settings') + 1]) as {
    hooks: { PreToolUse: { hooks: { command: string }[] }[] };
  };
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /agent-guard\.mjs/);
  assert.ok(!command.join(' ').includes(process.execPath), 'kein Node-Pfad des Hosts');
});

test('Sandbox: ohne Docker gesperrt mit Meldung, nichts läuft auf dem Host', async () => {
  const { calls, docker } = fakeDocker((command) =>
    command[1] === 'version' ? { exitCode: 1, durationMs: 1, output: 'Cannot connect to the Docker daemon' } : ok(),
  );
  const result = await runInSandbox(['claude', '-p', 'x'], WORKTREE, {
    runId: 'r1',
    project: 'ohne-docker',
    docker,
    environment: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /Docker ist nicht erreichbar.*auch nicht auf dem Host/s);
  assert.deepEqual(
    calls.map((call) => call.command[1]),
    ['version'],
    'kein docker run',
  );
  assert.match(sandboxBadge('ohne-docker') ?? '', /Docker ist nicht erreichbar/);
});

test('Sandbox: fehlendes Image sperrt den Lauf mit eigener Meldung', async () => {
  const { calls, docker } = fakeDocker((command) =>
    command[1] === 'image' ? { exitCode: 1, durationMs: 1, output: 'No such image' } : ok('27.0.0'),
  );
  const result = await runInSandbox(['claude', '-p', 'x'], WORKTREE, {
    runId: 'r2',
    project: 'ohne-image',
    docker,
    environment: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /Image „aideation-agent“ fehlt/);
  assert.ok(!calls.some((call) => call.command[1] === 'run'));
});

test('Sandbox: fehlende Anmeldung wird getrennt von Docker/Image gemeldet', async () => {
  const { calls, docker } = fakeDocker();
  const result = await runInSandbox(['claude', '-p', 'x'], WORKTREE, {
    runId: 'r3',
    project: 'ohne-token',
    docker,
    environment: { PATH: '/usr/bin' },
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /Anmeldung der Claude-CLI fehlt/);
  assert.doesNotMatch(result.output, /Docker ist nicht erreichbar|Image/);
  assert.ok(!calls.some((call) => call.command[1] === 'run'));
  assert.equal(credentialProblem(['npm', 'test'], {}), null, 'nur die Claude-CLI braucht die Anmeldung');
});

test('Sandbox: Lauf streamt, schwärzt den Token und entfernt den Container danach', async () => {
  const chunks: string[] = [];
  const { calls, docker } = fakeDocker((command) =>
    command[1] === 'run' && command.includes('aideation-agent') && !command.includes('chown')
      ? ok(`Token: ${TOKEN}\nfertig`)
      : ok(),
  );
  const result = await runInSandbox(['claude', '-p', 'x'], WORKTREE, {
    runId: 'r4',
    project: 'demo',
    name: 'aideation-r4',
    docker,
    environment: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
    onChunk: (chunk) => chunks.push(chunk),
  });
  assert.equal(result.exitCode, 0);
  assert.ok(!result.output.includes(TOKEN));
  assert.match(result.output, /\[REDACTED\]/);
  const run = calls.find((call) => call.command.includes('--cap-drop'));
  assert.ok(run, 'eigentlicher Lauf');
  assert.ok(!run.command.join(' ').includes(TOKEN));
  assert.equal(run.env?.CLAUDE_CODE_OAUTH_TOKEN, TOKEN, 'Wert nur in der Umgebung des Clients');
  assert.deepEqual(calls.at(-1)?.command, ['docker', 'rm', '-f', 'aideation-r4']);
  assert.equal(sandboxBadge('demo'), null);
});

test('Sandbox: Abbruch beendet den Container mit docker kill, nicht nur den Client', async () => {
  const controller = new AbortController();
  let release: (() => void) | undefined;
  const { calls, docker } = fakeDocker((command) => {
    if (command.includes('--cap-drop')) {
      // Der Client wartet, bis er beendet wird (runCommand beendet ihn beim Abbruch).
      return new Promise<CommandResult>((resolve) => {
        release = () => resolve({ exitCode: 137, durationMs: 1, output: 'Process ended by SIGKILL' });
        setTimeout(() => controller.abort(), 5);
      });
    }
    if (command[1] === 'kill') release?.();
    return ok();
  });
  const startedAt = Date.now();
  const result = await runInSandbox(['claude', '-p', 'x'], WORKTREE, {
    runId: 'r5',
    project: 'demo',
    name: 'aideation-r5',
    docker,
    signal: controller.signal,
    environment: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
  });
  assert.ok(Date.now() - startedAt < 10_000);
  assert.notEqual(result.exitCode, 0);
  const names = calls.map((call) => call.command.slice(1).join(' '));
  assert.ok(names.includes('kill aideation-r5'), 'docker kill');
  assert.equal(names.at(-1), 'rm -f aideation-r5', 'danach sicher entfernt');
});

test('Sandbox: schon abgebrochen – kein Docker-Aufruf', async () => {
  const controller = new AbortController();
  controller.abort();
  const { calls, docker } = fakeDocker();
  const result = await runInSandbox(['claude'], WORKTREE, {
    runId: 'r6',
    project: 'demo',
    docker,
    signal: controller.signal,
  });
  assert.equal(result.exitCode, 130);
  assert.equal(calls.length, 0);
});

test('Sandbox: Limit- und Anmeldefehler der CLI sind keine Sandbox-Fehler', () => {
  assert.match(
    sandboxFailureNote(1, "You've hit your monthly spend limit") ?? '',
    /Nutzungslimit.*kein Fehler der Sandbox/,
  );
  assert.match(sandboxFailureNote(1, 'Invalid API key · Please run /login') ?? '', /nicht angemeldet/);
  assert.match(sandboxFailureNote(125, 'docker: Error response from daemon') ?? '', /^Sandbox: Docker/);
  assert.equal(sandboxFailureNote(0, 'spend limit'), null);
  assert.equal(sandboxFailureNote(1, 'Tests fehlgeschlagen'), null);
});

test('Sandbox: Limit-Abbruch im Container wird als Pause bis zum Reset erkannt und der Container entfernt', async () => {
  const limit =
    "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage · your session limit resets 8:50pm (Europe/Zurich)";
  const { calls, docker } = fakeDocker((command) =>
    command.includes('--cap-drop') ? { exitCode: 1, durationMs: 1, output: limit } : ok('27'),
  );
  const result = await runInSandbox(['claude', '-p', 'x'], WORKTREE, {
    runId: 'r-limit',
    project: 'limit',
    name: 'aideation-r-limit',
    docker,
    environment: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /pausiert bis zum Reset/);
  // Der Runner (runner-steps) pausiert damit statt einen Fehlversuch zu zählen.
  const reset = usageLimitReset(result.output, new Date('2026-10-29T12:00:00'));
  assert.ok(reset, 'Limit trotz angehängtem Hinweis erkannt');
  assert.equal(reset.getHours(), 20);
  assert.deepEqual(calls.at(-1)?.command, ['docker', 'rm', '-f', 'aideation-r-limit'], 'Container entfernt');
  assert.equal(sandboxBadge('limit'), null, 'kein Sandbox-Problem im Badge');
});

test('Sandbox: Executor bildet den Arbeitsordner ab und reicht die Agent-Umgebung als Quelle weiter', async () => {
  const { calls, docker } = fakeDocker((command) => (command[1] === 'version' ? ok('27') : ok()));
  const execute = sandboxExecutor(WORKTREE, { runId: 'r7', project: 'demo', docker, name: 'aideation-r7' });
  await execute(['npm', 'test'], `${WORKTREE}/frontend`, { env: { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: TOKEN } });
  const run = calls.find((call) => call.command.includes('--cap-drop'));
  assert.ok(run);
  assert.equal(run.command[run.command.indexOf('-w') + 1], '/workspace/frontend');
  assert.deepEqual(run.command.slice(-2), ['npm', 'test']);
});

test('Sandbox: Aufräumen beim Start entfernt Container mit dem Label aideation.run', async () => {
  const { calls, docker } = fakeDocker((command) => (command[1] === 'ps' ? ok('abc123def456\n0123456789ab\n') : ok()));
  assert.equal(await removeLeftoverContainers(docker, '/'), 2);
  assert.deepEqual(calls[0].command, ['docker', 'ps', '-aq', '--filter', 'label=aideation.run']);
  assert.deepEqual(calls[1].command, ['docker', 'rm', '-f', 'abc123def456', '0123456789ab']);
  const none = fakeDocker((command) =>
    command[1] === 'ps' ? { exitCode: 1, durationMs: 1, output: 'docker: not found' } : ok(),
  );
  assert.equal(await removeLeftoverContainers(none.docker, '/'), 0, 'ohne Docker: nichts zu tun');
  assert.equal(none.calls.length, 1);
});

test('Sandbox: Abhängigkeiten werden einmal je Lockfile ins Volume installiert, bevor der Befehl läuft', async () => {
  const worktree = mkdtempSync(join(tmpdir(), 'sandbox-deps-'));
  try {
    writeFileSync(join(worktree, 'package.json'), '{"name":"demo"}');
    writeFileSync(join(worktree, 'package-lock.json'), '{"lockfileVersion":3}');
    const stamp = dependencyStamp(worktree);
    assert.match(stamp ?? '', /^[a-f0-9]{16}$/);
    const { calls, docker } = fakeDocker((command) => (command[1] === 'version' ? ok('27') : ok()));
    const execute = sandboxExecutor(worktree, { runId: 'r8', project: 'demo', docker, name: 'aideation-r8' });
    await execute(['npm', 'test'], worktree);
    const runs = calls.filter((call) => call.command.includes('--cap-drop'));
    assert.equal(runs.length, 2);
    assert.deepEqual(runs[0]?.command.slice(-3), dependencyCommand(stamp ?? ''));
    assert.match(runs[0]?.command.at(-1) ?? '', /npm install --ignore-scripts/);
    assert.ok(runs[0]?.command.at(-1)?.includes(DEPENDENCY_STAMP));
    assert.equal(runs[0]?.command[runs[0].command.indexOf('--network') + 1], SANDBOX_NETWORK);
    assert.deepEqual(runs[1]?.command.slice(-2), ['npm', 'test']);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test('Sandbox: scheitert die Installation, startet der Befehl nicht; lesende Läufe installieren nichts', async () => {
  const worktree = mkdtempSync(join(tmpdir(), 'sandbox-deps-'));
  try {
    writeFileSync(join(worktree, 'package.json'), '{"name":"demo"}');
    const { calls, docker } = fakeDocker((command) =>
      command[1] === 'version'
        ? ok('27')
        : command.at(-1)?.includes('npm install')
          ? { ...ok('E404'), exitCode: 1 }
          : ok(),
    );
    const result = await runInSandbox(['npm', 'test'], worktree, { runId: 'r9', project: 'demo', docker });
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /Abhängigkeiten liessen sich nicht/);
    assert.ok(!calls.some((call) => call.command.slice(-2).join(' ') === 'npm test'));
    const read = fakeDocker((command) => (command[1] === 'version' ? ok('27') : ok()));
    await runInSandbox(['npm', 'test'], worktree, {
      runId: 'r10',
      project: 'demo',
      docker: read.docker,
      readOnly: true,
    });
    assert.equal(read.calls.filter((call) => call.command.includes('--cap-drop')).length, 1);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test('Sandbox: localhost geht nie über den Egress-Proxy', () => {
  const run = args();
  assert.ok(run.includes(`NO_PROXY=${SANDBOX_NO_PROXY}`));
  assert.ok(run.includes(`no_proxy=${SANDBOX_NO_PROXY}`));
  assert.match(SANDBOX_NO_PROXY, /localhost/);
  assert.match(SANDBOX_NO_PROXY, /127\.0\.0\.1/);
});
