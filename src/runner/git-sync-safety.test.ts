import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { acquireTree, treeBusy } from '../core/project-lock.js';
import {
  BOT_IDENTITY,
  checkoutSprintBranch,
  commitAgentStep,
  enterOrderBranch,
  finishOrderBranch,
  mergeApprovedBranch,
  OrderBranchError,
  unresolvedConflicts,
} from './git-sync.js';

/** Projekt mit main und einem Commit; eigene Identität des Menschen in der Repo-Konfiguration. */
async function project(): Promise<{ cwd: string; git: (...args: string[]) => string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'git-safety-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  git('init', '-b', 'main');
  git('config', 'user.email', 'mensch@example.com');
  git('config', 'user.name', 'Mensch');
  await writeFile(join(cwd, 'base.txt'), 'base\n');
  git('add', '-A');
  git('commit', '-m', 'base');
  return { cwd, git };
}

const item = { id: '1a2b3c4d-0000', title: 'Login-Seite' };

test('Auftrag startet nicht, wenn fremde Änderungen im Arbeitsordner liegen', async () => {
  const { cwd, git } = await project();
  await writeFile(join(cwd, 'base.txt'), 'vom Assistenten geändert\n');
  await assert.rejects(enterOrderBranch(cwd, item, 'Sprint 1'), OrderBranchError);
  // Kein Branch gewechselt, nichts committet.
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git('rev-list', '--count', 'HEAD'), '1');
});

test('Testberichte zählen nicht als fremde Änderung und landen nicht im Auftrags-Commit', async () => {
  const { cwd, git } = await project();
  await mkdir(join(cwd, 'docs', 'tests', 'lauf-1'), { recursive: true });
  await writeFile(join(cwd, 'docs', 'tests', 'lauf-1', 'bericht.md'), '# Bericht\n');
  const branch = await enterOrderBranch(cwd, item, 'Sprint 1');
  assert.ok(branch);
  await writeFile(join(cwd, 'login.ts'), 'export {};\n');
  assert.ok(await commitAgentStep(cwd, item, 'Entwickler', 'Sprint 1', true, undefined, branch.branch));
  assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n'), ['login.ts']);
  // Commits von AIdeation tragen die Bot-Identität, nicht die des Menschen aus der Repo-Konfiguration.
  assert.equal(
    git('log', '-1', '--format=%an <%ae>'),
    `${BOT_IDENTITY.GIT_AUTHOR_NAME} <${BOT_IDENTITY.GIT_AUTHOR_EMAIL}>`,
  );
});

test('Reste einer abgebrochenen npm-Installation (.node_modules-*) landen nicht im Auftrags-Commit', async () => {
  const { cwd, git } = await project();
  const branch = await enterOrderBranch(cwd, item, 'Sprint 1');
  assert.ok(branch);
  await symlink('/workspace/node_modules', join(cwd, '.node_modules-EFVt3rln'));
  await writeFile(join(cwd, 'login.ts'), 'export {};\n');
  assert.ok(await commitAgentStep(cwd, item, 'Entwickler', 'Sprint 1', true, undefined, branch.branch));
  assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n'), ['login.ts']);
});

test('gescheiterter Auftrag mit vorhandenem .dev-log: Stand wird gesichert, nichts bleibt gestagt liegen', async () => {
  const { cwd, git } = await project();
  const branch = await enterOrderBranch(cwd, item, 'Sprint 1');
  assert.ok(branch);
  // Agent-Ablage (von Git über info/exclude ignoriert) und ein Test des Testers, der noch fehlschlägt.
  await mkdir(join(cwd, '.dev-log'), { recursive: true });
  await writeFile(join(cwd, '.dev-log', 'anhang.txt'), 'intern\n');
  await writeFile(join(cwd, 'login.test.ts'), 'export {};\n');
  const result = await finishOrderBranch(cwd, item, branch, 'Sprint 1', false);
  assert.equal(result.merged, false);
  assert.match(result.message, /Zwischenstand auf .* gesichert/);
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
  assert.match(git('show', '--name-only', '--format=', branch.branch), /login\.test\.ts/);
  // Der nächste Auftrag startet, statt an „fremden Änderungen“ zu scheitern.
  assert.ok(await enterOrderBranch(cwd, { id: '5e6f7a8b-0000', title: 'Profil' }, 'Sprint 1'));
});

test('kein Commit und kein Merge, wenn jemand den Branch gewechselt hat', async () => {
  const { cwd, git } = await project();
  const branch = await enterOrderBranch(cwd, item, 'Sprint 1');
  assert.ok(branch);
  assert.equal(branch.base, 'sprint/sprint-1');
  git('checkout', 'sprint/sprint-1');
  await writeFile(join(cwd, 'login.ts'), 'export {};\n');
  assert.equal(await commitAgentStep(cwd, item, 'Entwickler', 'Sprint 1', true, undefined, branch.branch), null);
  const result = await finishOrderBranch(cwd, item, branch, 'Sprint 1', true);
  assert.equal(result.merged, false);
  assert.match(result.message, /steht auf sprint\/sprint-1/);
  assert.equal(git('rev-list', '--count', 'sprint/sprint-1'), '1');
});

test('sauberer fremder Auftrags-Branch: der Auftrag ohne Sprint verlässt ihn und zweigt von main ab', async () => {
  const { cwd, git } = await project();
  git('checkout', '-b', 'auftrag/99999999-anderer');
  await writeFile(join(cwd, 'anderer.ts'), 'export {};\n');
  git('add', '-A');
  git('commit', '-m', 'anderer Auftrag');
  const branch = await enterOrderBranch(cwd, item, null);
  assert.equal(branch?.base, 'main');
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), branch?.branch);
  // Nie vom fremden Auftrag abgezweigt: seine Arbeit bleibt auf seinem Branch.
  assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'main'));
});

test('fremder Auftrags-Branch mit offenen Änderungen: OrderBranchError, nichts wird angefasst', async () => {
  const { cwd, git } = await project();
  git('checkout', '-b', 'auftrag/99999999-anderer');
  await writeFile(join(cwd, 'halb.ts'), 'export const halb = 1;\n');
  await assert.rejects(enterOrderBranch(cwd, item, null), OrderBranchError);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'auftrag/99999999-anderer');
  assert.equal(await readFile(join(cwd, 'halb.ts'), 'utf8'), 'export const halb = 1;\n');
});

test('losgelöster Stand ohne Sprint: der Auftrag arbeitet auf main auf statt auf „HEAD“', async () => {
  const { cwd, git } = await project();
  git('checkout', '-q', '--detach', 'main');
  const branch = await enterOrderBranch(cwd, item, null);
  assert.equal(branch?.base, 'main');
});

test('scheitert der Wechsel auf den Sprint-Branch, startet der Auftrag nicht (kein Merge direkt in main)', async () => {
  const { cwd, git } = await project();
  // Z. B. blockieren lokale Änderungen den Checkout: jeder Wechsel auf den Sprint-Branch scheitert.
  const execute: CommandExecutor = (command, directory, options) =>
    command[1] === 'checkout' && command.includes('sprint/sprint-1')
      ? Promise.resolve({ exitCode: 1, durationMs: 1, output: 'error: checkout blockiert' })
      : runCommand(command, directory, options);
  await assert.rejects(enterOrderBranch(cwd, item, 'Sprint 1', execute), /Sprint-Branch sprint\/sprint-1/);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git('branch', '--list', 'auftrag/*'), '');
});

test('Hooks des Projekts laufen beim Commit nicht, nichts bleibt gestagt', async () => {
  const { cwd, git } = await project();
  const branch = await enterOrderBranch(cwd, item, 'Sprint 1');
  assert.ok(branch);
  await writeFile(join(cwd, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await writeFile(join(cwd, 'login.ts'), 'export {};\n');
  await finishOrderBranch(cwd, item, branch, 'Sprint 1', true);
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(git('log', '--all', '--format=%s', '--', 'login.ts').includes('wip('), false);
});

test('eine Markdown-Zeile „=======“ ist kein Konfliktmarker', async () => {
  const { cwd, git } = await project();
  git('checkout', '-b', 'seite');
  await writeFile(join(cwd, 'base.txt'), 'Titel\n=======\nseite\n');
  git('commit', '-am', 'seite');
  git('checkout', 'main');
  await writeFile(join(cwd, 'base.txt'), 'main\n');
  git('commit', '-am', 'main');
  assert.throws(() => git('merge', 'seite'));
  assert.deepEqual(await unresolvedConflicts(cwd), ['base.txt']);
  await writeFile(join(cwd, 'base.txt'), 'Titel\n=======\ngelöst\n');
  assert.deepEqual(await unresolvedConflicts(cwd), []);
});

test('im verknüpften Worktree landen die Ausschlüsse im gemeinsamen Git-Verzeichnis', async () => {
  const { cwd, git } = await project();
  const agent = `${cwd}-agent`;
  git('worktree', 'add', '-q', '--detach', agent, 'main');
  await writeFile(join(agent, '.env'), 'GEHEIM=1\n');
  // .env wird ausgeschlossen, bevor nach fremden Änderungen gesucht wird: sie hält den Auftrag nicht auf.
  assert.ok(await enterOrderBranch(agent, item, 'Sprint 1'));
  const exclude = await readFile(join(cwd, '.git', 'info', 'exclude'), 'utf8');
  assert.ok(exclude.split('\n').includes('.env'));
});

test('Arbeitsordner-Sperre: belegt, solange sie gehalten wird, und nacheinander vergeben', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'tree-lock-'));
  assert.equal(treeBusy(folder), false);
  const first = await acquireTree(folder);
  assert.equal(treeBusy(folder), true);
  let second = false;
  const waiting = acquireTree(`${folder}/.`).then((release) => {
    second = true;
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(second, false);
  first();
  (await waiting)();
  assert.equal(second, true);
  assert.equal(treeBusy(folder), false);
});

test('Auftrag ohne Sprint im losgelösten Worktree landet in main, während main im Hauptordner ausgecheckt ist', async () => {
  const { cwd, git } = await project();
  const agent = `${cwd}-agent-nosprint`;
  git('worktree', 'add', '-q', '--detach', agent, 'main');
  const mainBefore = git('rev-parse', 'main');
  const branch = await enterOrderBranch(agent, item, null);
  assert.ok(branch);
  assert.notEqual(branch.base, 'HEAD');
  assert.equal(branch.base, 'main');
  await writeFile(join(agent, 'fix.ts'), 'export {};\n');
  const result = await finishOrderBranch(agent, item, branch, 'Betrieb', true);
  assert.equal(result.merged, true);
  assert.notEqual(git('rev-parse', 'main'), mainBefore);
  assert.match(git('ls-tree', '-r', '--name-only', 'main'), /fix\.ts/);
});

// Die getrimmte Ausgabe von „git status“ kostete den ersten Pfad ein Zeichen („docs/tests/…“ → „ocs/tests/…“): Dann
// galten ignorierte Testberichte als fremde Änderung und blockierten jeden Auftrag.
test('Geänderter Testbericht in docs/tests als erste Statuszeile blockiert keinen Auftrag', async () => {
  const { cwd, git } = await project();
  await mkdir(join(cwd, 'docs', 'tests'), { recursive: true });
  await writeFile(join(cwd, 'docs', 'tests', 'bericht.md'), 'alt\n');
  git('add', '-A');
  git('commit', '-m', 'bericht');
  await writeFile(join(cwd, 'docs', 'tests', 'bericht.md'), 'neu\n');
  const branch = await enterOrderBranch(cwd, item, null);
  assert.ok(branch, 'Auftrags-Branch wurde angelegt');
});

test('Fremde Änderung wird mit vollständigem Pfad gemeldet', async () => {
  const { cwd } = await project();
  await mkdir(join(cwd, 'docs'), { recursive: true });
  await writeFile(join(cwd, 'base.txt'), 'geändert\n');
  await assert.rejects(enterOrderBranch(cwd, item, null), /\(base\.txt\)/);
});

// Ein neuer Sprint zweigte vom lokalen main ab, auch wenn GitHub weiter war (z. B. gemergter Pull Request des
// Vorgänger-Sprints) – dann fehlte ihm dessen Arbeit.
test('Neuer Sprint-Branch startet vom neueren origin/main, wenn das lokale main nur zurückliegt', async () => {
  const { cwd: remote } = await project();
  const clone = await mkdtemp(join(tmpdir(), 'git-safety-clone-'));
  execFileSync('git', ['clone', '-q', remote, clone]);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: clone, stdio: 'pipe' }).toString().trim();
  // GitHub (hier: remote) bekommt einen neuen Commit, den das lokale main nicht hat.
  await writeFile(join(remote, 'vorgaenger.txt'), 'Sprint davor\n');
  execFileSync('git', ['add', '-A'], { cwd: remote });
  execFileSync('git', ['commit', '-q', '-m', 'Sprint davor'], { cwd: remote });
  const branch = await checkoutSprintBranch(clone, 'Sprint 2');
  assert.equal(branch, 'sprint/sprint-2');
  assert.equal(git('show', 'HEAD:vorgaenger.txt'), 'Sprint davor');
});

// Früher kam main erst beim Sprint-Abschluss in den Sprint-Branch; Korrekturen auf main stauten sich zu grossen
// Konflikten. Jetzt holt jeder neue Auftrag den aktuellen main zuerst in den Sprint-Branch.
test('Neuer Auftrag im Sprint: aktueller main kommt vorher in den Sprint-Branch; bei Konflikt bleibt alles wie es war', async () => {
  const { cwd, git } = await project();
  git('checkout', '-q', '-b', 'sprint/sprint-1');
  await writeFile(join(cwd, 'sprint.txt'), 'sprint\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'sprint-arbeit');
  git('checkout', '-q', 'main');
  await writeFile(join(cwd, 'fix.txt'), 'hotfix auf main\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'hotfix');
  const first = await enterOrderBranch(cwd, item, 'Sprint 1');
  assert.equal(first?.base, 'sprint/sprint-1');
  assert.equal(git('show', 'sprint/sprint-1:fix.txt'), 'hotfix auf main');

  // Konflikt: main und Sprint ändern dieselbe Zeile – der Sprint-Branch bleibt unverändert, der Auftrag startet trotzdem.
  git('checkout', '-q', 'sprint/sprint-1');
  await writeFile(join(cwd, 'base.txt'), 'sprint-version\n');
  git('commit', '-q', '-am', 'sprint ändert base');
  git('checkout', '-q', 'main');
  await writeFile(join(cwd, 'base.txt'), 'main-version\n');
  git('commit', '-q', '-am', 'main ändert base');
  const before = git('rev-parse', 'sprint/sprint-1');
  const second = await enterOrderBranch(cwd, { id: '9f9f9f9f-0000', title: 'Zweiter Auftrag' }, 'Sprint 1');
  assert.ok(second);
  assert.equal(git('rev-parse', 'sprint/sprint-1'), before);
  assert.equal(git('status', '--porcelain'), '');
});

// Auftrags-Commits nehmen Testberichte (docs/tests) bewusst nicht mit; ein neu geschriebener Bericht sperrte deshalb
// jede Freigabe mit „Offene Änderungen im Arbeitsordner“.
test('Freigabe-Merge: geänderter Testbericht in docs/tests sperrt nicht, echte offene Änderungen schon', async () => {
  const { cwd, git } = await project();
  await mkdir(join(cwd, 'docs', 'tests'), { recursive: true });
  await writeFile(join(cwd, 'docs', 'tests', 'bericht.md'), 'alt\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'bericht');
  git('checkout', '-q', '-b', 'auftrag/aa11bb22-feature');
  await writeFile(join(cwd, 'feature.txt'), 'neu\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feature');
  git('checkout', '-q', 'main');
  await writeFile(join(cwd, 'docs', 'tests', 'bericht.md'), 'neu geschrieben\n');
  const merged = await mergeApprovedBranch(cwd, { title: 'Feature' }, 'auftrag/aa11bb22-feature', 'main');
  assert.equal(merged.merged, true, merged.message);
  await writeFile(join(cwd, 'base.txt'), 'offen\n');
  git('checkout', '-q', '-b', 'auftrag/cc33dd44-zweites');
  git('checkout', '-q', 'main');
  const blocked = await mergeApprovedBranch(cwd, { title: 'Zweites' }, 'auftrag/cc33dd44-zweites', 'main');
  assert.equal(blocked.merged, false);
  assert.match(blocked.message, /Offene Änderungen im Arbeitsordner \(base\.txt\)/);
});

test('Auftrags-Branch aus einem abgebrochenen Sprint: geparkt, der Auftrag startet neu von main ohne dessen Commits', async () => {
  const { cwd, git } = await project();
  const own = 'auftrag/1a2b3c4d-login-seite';
  git('checkout', '-b', 'sprint/sprint-alt');
  await writeFile(join(cwd, 'ungeprueft.ts'), 'export {};\n');
  git('add', '-A');
  git('commit', '-m', 'Auftrag eines abgebrochenen Sprints', '-m', 'Auftrag: 99999999-0000');
  git('checkout', '-b', own);
  await writeFile(join(cwd, 'login.ts'), 'export {};\n');
  git('add', '-A');
  git('commit', '-m', 'wip(Sprint alt): Login-Seite', '-m', `Auftrag: ${item.id}`);
  git('checkout', 'main');
  const branch = await enterOrderBranch(cwd, item, null);
  assert.deepEqual(branch, { branch: own, base: 'main' });
  assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'main'));
  // Die bisherige Arbeit bleibt auf dem geparkten Branch erhalten.
  const parked = git('branch', '--list', 'wip/1a2b3c4d-login-seite-fremde-basis-*', '--format=%(refname:short)');
  assert.ok(parked);
  assert.equal(git('show', `${parked}:login.ts`), 'export {};');
});

test('Auftrags-Branch mit nur eigenen Commits wird fortgesetzt und bekommt den neuen main', async () => {
  const { cwd, git } = await project();
  const own = 'auftrag/1a2b3c4d-login-seite';
  git('checkout', '-b', own);
  await writeFile(join(cwd, 'login.ts'), 'export {};\n');
  git('add', '-A');
  git('commit', '-m', 'wip(auftrag): Login-Seite', '-m', `Auftrag: ${item.id}`);
  git('checkout', 'main');
  await writeFile(join(cwd, 'neu.txt'), 'neu\n');
  git('add', '-A');
  git('commit', '-m', 'main geht weiter');
  const branch = await enterOrderBranch(cwd, item, null);
  assert.deepEqual(branch, { branch: own, base: 'main' });
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), own);
  assert.equal(await readFile(join(cwd, 'login.ts'), 'utf8'), 'export {};\n');
  assert.equal(await readFile(join(cwd, 'neu.txt'), 'utf8'), 'neu\n');
  assert.equal(git('branch', '--list', 'wip/*'), '');
});
