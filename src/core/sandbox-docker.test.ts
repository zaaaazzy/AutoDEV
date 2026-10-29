import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCommand } from './command.js';
import { containerName, runInSandbox, sandboxProblem } from './sandbox.js';

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
