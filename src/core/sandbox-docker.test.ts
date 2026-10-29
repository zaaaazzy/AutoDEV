import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runCommand } from './command.js';
import { containerName, runInSandbox, sandboxProblem } from './sandbox.js';
import { runTestGate } from '../runner/git-sync/ci.js';
import { projectTestExecutor } from '../runner/test-sandbox.js';
import { captureInSandbox } from '../runner/visual-sandbox.js';
import { DEFAULT_VISUAL_SETTINGS } from '../runner/visual-settings.js';

/**
 * Integrationstest gegen echtes Docker und das Image aideation-agent. Ohne Docker oder Image übersprungen; im CI-Job
 * docker (DEV_LOG_TEST_REQUIRE_DOCKER=1) schlägt er dann fehl, statt still zu fehlen.
 */
const problem = await sandboxProblem(runCommand).catch((error: unknown) => String(error));
const required = process.env.DEV_LOG_TEST_REQUIRE_DOCKER === '1';
const skip = problem && !required ? `Docker-Sandbox nicht verfügbar: ${problem}` : false;

function fixture(): { root: string; worktree: string; secret: string; cleanup: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aideation-sandbox-')));
  const worktree = join(root, 'agent');
  mkdirSync(worktree);
  writeFileSync(join(worktree, 'drin.txt'), 'im Worktree\n');
  // Ein „Home“ neben dem Worktree mit einem Schlüssel: liegt ausserhalb von /workspace.
  mkdirSync(join(root, 'home', '.ssh'), { recursive: true });
  const secret = join(root, 'home', '.ssh', 'id_ed25519');
  writeFileSync(secret, 'PRIVATER-SCHLUESSEL\n');
  return { root, worktree, secret, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test(
  'Sandbox (Docker): ~/.ssh des Hosts und Dateien ausserhalb von /workspace sind nicht lesbar',
  { skip },
  async () => {
    assert.equal(problem, null, problem ?? '');
    const { worktree, secret, root, cleanup } = fixture();
    try {
      const hostSsh = join(homedir(), '.ssh');
      const script = [
        'cat /workspace/drin.txt',
        `if cat ${JSON.stringify(secret)} 2>/dev/null; then echo LECK-NEBENORDNER; fi`,
        `if ls ${JSON.stringify(hostSsh)} 2>/dev/null; then echo LECK-SSH; fi`,
        `if ls ${JSON.stringify(root)} 2>/dev/null; then echo LECK-ELTERNORDNER; fi`,
        'if [ -e /var/run/docker.sock ]; then echo LECK-SOCKET; fi',
        'if ls "$HOME/.claude" 2>/dev/null; then echo LECK-CLAUDE; fi',
        'id -u',
      ].join('\n');
      const result = await runInSandbox(['sh', '-c', script], worktree, {
        runId: 'integrationstest',
        project: 'integrationstest',
        timeoutMs: 120_000,
      });
      assert.equal(result.exitCode, 0, result.output);
      assert.match(result.output, /im Worktree/);
      assert.doesNotMatch(result.output, /LECK-|PRIVATER-SCHLUESSEL/);
      if (process.platform !== 'win32') {
        assert.match(
          result.output,
          new RegExp(`^${process.getuid?.()}$`, 'm'),
          'läuft als Worker-Benutzer, nicht root',
        );
      }
    } finally {
      cleanup();
    }
  },
);

test('Sandbox (Docker): Testbefehl im Gate, der ~/.ssh des Hosts lesen will, scheitert', { skip }, async () => {
  assert.equal(problem, null, problem ?? '');
  const { worktree, cleanup } = fixture();
  try {
    const hostSsh = join(homedir(), '.ssh');
    const execute = await projectTestExecutor({ project: 'integrationstest', cwd: worktree, runId: 'gate-ssh' });
    const log: string[] = [];
    await assert.rejects(
      runTestGate(
        execute,
        worktree,
        [['sh', '-c', `ls ${JSON.stringify(hostSsh)} && cat ${JSON.stringify(hostSsh)}/*`]],
        log,
      ),
      /Push abgelehnt/,
    );
    assert.equal(log.length, 0, 'Gate nicht grün');
  } finally {
    cleanup();
  }
});

test(
  'Sandbox (Docker): AIdeation-Datenbank und LAN sind aus dem Agent-Container nicht erreichbar',
  { skip },
  async () => {
    assert.equal(problem, null, problem ?? '');
    const { worktree, cleanup } = fixture();
    try {
      // Direkt (db:5432, Host-Port 5433, Gateway) und über den Egress-Proxy (CONNECT): nichts darf antworten.
      const script = `
const net = require('node:net');
const targets = [['db', 5432], ['127.0.0.1', 5433], ['host.docker.internal', 5433], ['172.17.0.1', 5433], ['192.168.1.1', 80]];
const probe = ([host, port]) => new Promise((done) => {
  const socket = net.connect({ host, port, timeout: 3000 });
  socket.on('connect', () => { socket.destroy(); done('OFFEN ' + host + ':' + port); });
  socket.on('timeout', () => { socket.destroy(); done(''); });
  socket.on('error', () => done(''));
});
const viaProxy = (target) => new Promise((done) => {
  const url = new URL(process.env.HTTPS_PROXY);
  const socket = net.connect({ host: url.hostname, port: Number(url.port), timeout: 5000 }, () =>
    socket.write('CONNECT ' + target + ' HTTP/1.1\\r\\nHost: ' + target + '\\r\\n\\r\\n'));
  socket.once('data', (chunk) => { socket.destroy(); done(/ 200 /.test(String(chunk)) ? 'PROXY ' + target : ''); });
  socket.on('timeout', () => { socket.destroy(); done(''); });
  socket.on('error', () => done(''));
});
Promise.all([...targets.map(probe), viaProxy('host.docker.internal:5433'), viaProxy('db:5432')]).then((found) => {
  console.log(found.filter(Boolean).join('\\n') || 'GESPERRT');
});`;
      const result = await runInSandbox(['node', '-e', script], worktree, {
        runId: 'netztest',
        project: 'integrationstest',
        timeoutMs: 120_000,
      });
      assert.equal(result.exitCode, 0, result.output);
      assert.match(result.output, /GESPERRT/);
      assert.doesNotMatch(result.output, /OFFEN|PROXY/);
    } finally {
      cleanup();
    }
  },
);

test('Sandbox (Docker): visueller Tester nimmt Desktop und Handy aus dem Container auf', { skip }, async () => {
  assert.equal(problem, null, problem ?? '');
  const server = createServer((_request, response) =>
    response.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>Vorschau</h1><p>Aus dem Container.</p>'),
  );
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const capture = captureInSandbox({ runId: 'visualtest', project: 'integrationstest' });
    const pages = await capture({
      baseUrl: `http://127.0.0.1:${port}`,
      pages: ['/'],
      settings: { ...DEFAULT_VISUAL_SETTINGS },
      credentials: null,
      signal: new AbortController().signal,
    });
    assert.deepEqual(pages.map((page) => page.device).sort(), ['desktop', 'mobile'].sort());
    for (const page of pages) {
      assert.ok(page.capture.png && page.capture.png.subarray(1, 4).toString() === 'PNG', page.capture.error ?? '');
    }
  } finally {
    server.close();
  }
});

test('Sandbox (Docker): Abbruch beendet den Container innerhalb von 10 Sekunden', { skip }, async () => {
  assert.equal(problem, null, problem ?? '');
  const { worktree, cleanup } = fixture();
  const name = containerName('abbruchtest');
  const controller = new AbortController();
  try {
    let ready: () => void = () => undefined;
    const started = new Promise<void>((resolve) => (ready = resolve));
    const running = runInSandbox(['sh', '-c', 'echo bereit; sleep 300'], worktree, {
      runId: 'abbruchtest',
      project: 'integrationstest',
      name,
      signal: controller.signal,
      onChunk: (chunk) => {
        if (chunk.includes('bereit')) ready();
      },
    });
    // Endet der Lauf vorzeitig (z. B. Image-Fehler), nicht ewig auf „bereit“ warten.
    await Promise.race([started, running]);
    const abortedAt = Date.now();
    controller.abort();
    // runInSandbox kehrt erst nach docker kill und docker rm -f zurück.
    const result = await running;
    assert.notEqual(result.exitCode, 0);
    assert.ok(Date.now() - abortedAt < 10_000, `nach ${Date.now() - abortedAt} ms`);
    const left = await runCommand(['docker', 'ps', '-aq', '--filter', `name=${name}`], worktree, { timeoutMs: 20_000 });
    assert.equal(left.output.trim(), '', 'kein Container übrig');
  } finally {
    controller.abort();
    cleanup();
  }
});
