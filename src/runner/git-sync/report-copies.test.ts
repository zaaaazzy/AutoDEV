import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCommand } from '../../core/command.js';
import { useLatestMain } from '../test-request.js';
import { gitHelpers } from './git-helpers.js';
import { checkoutTarget } from './report-copies.js';

const REPORT = 'docs/tests/2026-10-22_20-20/bericht.md';

/**
 * Wie im Agent-Ordner am 22.10.: Der Auftrags-Branch zweigt ab, danach landet der Testbericht auf main. Im
 * Agent-Worktree (auf dem Auftrag) liegt der Bericht noch unversioniert.
 */
async function setup(): Promise<{ human: string; agents: string; git: (cwd: string, ...args: string[]) => string }> {
  const root = await mkdtemp(join(tmpdir(), 'report-copies-'));
  const human = join(root, 'source');
  const agents = join(root, 'agents');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    })
      .toString()
      .trim();
  await mkdir(human, { recursive: true });
  git(human, 'init', '-q', '-b', 'main');
  await writeFile(join(human, 'a.txt'), 'a\n');
  git(human, 'add', '-A');
  git(human, 'commit', '-q', '-m', 'eins');
  git(human, 'branch', 'auftrag/1a2b3c4d-push');
  await mkdir(join(human, 'docs/tests/2026-10-22_20-20'), { recursive: true });
  await writeFile(join(human, REPORT), '# Testbericht\n\nAlles grün.\n');
  git(human, 'add', '-A');
  git(human, 'commit', '-q', '-m', 'Testbericht Gate');
  git(human, 'worktree', 'add', '-q', agents, 'auftrag/1a2b3c4d-push');
  await mkdir(join(agents, 'docs/tests/2026-10-22_20-20'), { recursive: true });
  await writeFile(join(agents, REPORT), '# Testbericht\n\nAlles grün.\n');
  return { human, agents, git };
}

test('checkoutTarget: Ziel ohne Optionen, bei -b der Startpunkt', () => {
  assert.equal(checkoutTarget(['checkout', 'main']), 'main');
  assert.equal(checkoutTarget(['checkout', '-q', '--detach', 'main']), 'main');
  assert.equal(checkoutTarget(['checkout', '--no-track', '-b', 'sprint/s1', 'abc123']), 'abc123');
  assert.equal(checkoutTarget(['checkout', '-b', 'auftrag/neu']), null);
  assert.equal(checkoutTarget(['checkout', 'main', '--', 'a.txt']), 'main');
});

test('Checkout: lose Kopie eines Testberichts, den das Ziel gleich enthält, blockiert nicht mehr', async () => {
  const { agents, git } = await setup();
  const { must } = gitHelpers(runCommand, agents);
  await writeFile(join(agents, 'docs/tests/eigener-entwurf.md'), 'nur hier\n');
  await must('checkout', '-q', '--detach', 'main');
  assert.equal(git(agents, 'rev-parse', 'HEAD'), git(agents, 'rev-parse', 'main'));
  assert.equal(git(agents, 'show', `HEAD:${REPORT}`), '# Testbericht\n\nAlles grün.');
  // Was das Ziel nicht kennt, bleibt liegen.
  assert.ok(existsSync(join(agents, 'docs/tests/eigener-entwurf.md')));
});

test('Checkout: abweichender Testbericht bleibt erhalten, der Checkout bricht wie bisher ab', async () => {
  const { agents } = await setup();
  await writeFile(join(agents, REPORT), '# Testbericht\n\nlokal ergänzt\n');
  const { must } = gitHelpers(runCommand, agents);
  await assert.rejects(must('checkout', '-q', '--detach', 'main'), /git checkout fehlgeschlagen/);
  assert.ok(existsSync(join(agents, REPORT)));
});

test('Test-Anfrage: useLatestMain wechselt trotz loser Berichtskopie auf main', async () => {
  const { agents, git } = await setup();
  const branch = await useLatestMain(agents, runCommand);
  assert.equal(branch, 'auftrag/1a2b3c4d-push');
  assert.equal(git(agents, 'rev-parse', 'HEAD'), git(agents, 'rev-parse', 'main'));
});
