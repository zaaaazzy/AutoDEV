import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import type { CommandExecutor } from '../core/command.js';
import { acquireTree } from '../core/project-lock.js';
import { commitAgentStep, enterOrderBranch } from '../runner/git-sync.js';
import { claimChatTree } from './chat.js';
import { runAuthorAgent } from './requirements.js';

/** Projekt mit main und einem Commit. */
async function project(): Promise<{ cwd: string; git: (...args: string[]) => string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'chat-tree-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  git('init', '-b', 'main');
  git('config', 'user.email', 'mensch@example.com');
  git('config', 'user.name', 'Mensch');
  await writeFile(join(cwd, 'base.txt'), 'base\n');
  git('add', '-A');
  git('commit', '-m', 'base');
  return { cwd, git };
}

/** Datenbank-Fake: der Assistent mit Claude-CLI, sonst leere Antworten. */
const pool = {
  query: async (sql: string) => ({
    rows: /FROM agents\b/.test(sql)
      ? [{ instructions: '', command: ['claude', '-p', '{prompt}'], allowedCommands: null, fileScope: [] }]
      : [],
  }),
} as unknown as Pool;

/**
 * Fake-Assistent, der den Fehler aus dem Code-Review nachstellt: Darf er die Shell benutzen, führt er im Arbeitsordner
 * `git checkout main` aus. Sonst kann er es nicht.
 */
function checkoutAssistant(cwd: string): { execute: CommandExecutor; checkedOut: () => boolean } {
  let checkedOut = false;
  const execute: CommandExecutor = async (command, _cwd, options) => {
    if (!/--disallowedTools \S*\bBash\b/.test(command.join(' '))) {
      execFileSync('git', ['checkout', '-q', 'main'], { cwd, stdio: 'pipe' });
      checkedOut = true;
    }
    options?.onChunk?.(JSON.stringify({ type: 'result', result: 'erledigt', is_error: false }));
    return { exitCode: 0, durationMs: 1, output: '' };
  };
  return { execute, checkedOut: () => checkedOut };
}

test('Chat während des Entwickler-Schritts: kein `git checkout main`, Entwickler-Commit landet auf dem Auftrags-Branch', async () => {
  const { cwd, git } = await project();
  const link = `${cwd}-link`;
  await symlink(cwd, link);
  const item = { id: 'ddd1e74e-0000', title: 'Login-Seite' };
  // Entwickler: runWorkflow hält den Ordner ab dem ersten ändernden Agent und arbeitet auf dem Auftrags-Branch.
  const releaseDeveloper = await acquireTree(cwd);
  try {
    const branch = await enterOrderBranch(cwd, item, 'Sprint 1');
    assert.ok(branch);
    await writeFile(join(cwd, 'login.ts'), 'export {};\n');

    // Chat-Nachricht kommt währenddessen – auch über einen anderen Pfad (Symlink) auf denselben Ordner.
    const chat = await claimChatTree(link);
    assert.equal(chat.readOnly, true, 'Ordner belegt → Chat nur lesend');
    assert.equal(chat.releaseTree, undefined);
    const assistant = checkoutAssistant(cwd);
    const options = { project: 'p', cwd: link, timeoutMs: 1000 };
    await runAuthorAgent(
      pool,
      options,
      () => 'Wechsle auf main.',
      assistant.execute,
      'assistant',
      undefined,
      undefined,
      null,
      undefined,
      chat.readOnly,
    );
    assert.equal(assistant.checkedOut(), false, 'ohne Shell kein Branch-Wechsel');
    // Auftragsautor (draftRequirements) läuft ohne Sperre parallel – und ebenso nur lesend.
    const author = checkoutAssistant(cwd);
    await runAuthorAgent(pool, options, () => 'Anforderung', author.execute, 'author');
    assert.equal(author.checkedOut(), false);

    assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), branch.branch);
    assert.ok(await commitAgentStep(cwd, item, 'Entwickler', 'Sprint 1', true, undefined, branch.branch));
    assert.equal(git('rev-list', '--count', 'main'), '1', 'nichts vom Entwickler auf main');
    assert.equal(git('log', '-1', '--format=%H', branch.branch), git('rev-parse', 'HEAD'));
    assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n'), ['login.ts']);
  } finally {
    releaseDeveloper();
  }

  // Gegenprobe: Ist der Ordner frei, hält der Chat ihn und behält seine Rechte (der Fake wechselt dann wirklich).
  const chat = await claimChatTree(cwd);
  try {
    assert.equal(chat.readOnly, false);
    const assistant = checkoutAssistant(cwd);
    await runAuthorAgent(
      pool,
      { project: 'p', cwd, timeoutMs: 1000 },
      () => 'x',
      assistant.execute,
      'assistant',
      undefined,
      undefined,
      null,
      undefined,
      chat.readOnly,
    );
    assert.equal(assistant.checkedOut(), true, 'Fake erkennt Schreibrechte – der Test oben prüft also wirklich etwas');
    assert.equal((await claimChatTree(cwd)).readOnly, true, 'solange der Chat schreibt, ist der Ordner belegt');
  } finally {
    chat.releaseTree?.();
  }
});
