import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import { runCommand } from '../core/command.js';
import { enterOrderBranch } from './git-sync.js';
import { type RunContext, settleItem } from './runner-steps.js';

/** Projekt mit main und einem Commit. */
async function project(): Promise<{ cwd: string; git: (...args: string[]) => string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'git-interrupted-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  git('init', '-b', 'main');
  git('config', 'user.email', 'mensch@example.com');
  git('config', 'user.name', 'Mensch');
  await writeFile(join(cwd, 'base.txt'), 'base\n');
  git('add', '-A');
  git('commit', '-m', 'base');
  return { cwd, git };
}

function recordingPool(): { pool: Pool; queries: { sql: string; values: unknown[] }[] } {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  return { pool, queries };
}

const first = { id: 'aaaaaaaa-0000-4000-8000-000000000001', projectSlug: 'p', title: 'Login-Seite', description: '' };
const second = { id: 'bbbbbbbb-0000-4000-8000-000000000002', projectSlug: 'p', title: 'Statistik', description: '' };

test('Unterbrochener Auftrag (Nutzungslimit, Neustart, Pause): WIP gesichert, Ordner sauber auf der Basis', async () => {
  const { cwd, git } = await project();
  const branch = await enterOrderBranch(cwd, first, null);
  assert.ok(branch);
  // Der Entwickler war mitten in der Arbeit: geänderte und neue Dateien, nichts committet.
  await writeFile(join(cwd, 'base.txt'), 'base\nhalb fertig\n');
  await writeFile(join(cwd, 'login.ts'), 'export const login = 1;\n');
  const { pool, queries } = recordingPool();
  const ctx = {
    pool,
    item: first,
    options: { cwd, timeoutMs: 1 },
    execute: runCommand,
    branch,
  } as unknown as RunContext;

  await settleItem(ctx, false, true);

  // Der Ordner steht wieder auf main und ist sauber – der nächste Auftrag kann starten.
  assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(git('status', '--porcelain'), '');
  // Die Arbeit liegt als Commit auf dem Auftrags-Branch.
  assert.deepEqual(git('show', '--name-only', '--format=', branch.branch).split('\n').sort(), ['base.txt', 'login.ts']);
  // Der Auftrag bleibt eingeplant (kein „blockiert“).
  const settled = queries.find((query) => query.sql.includes('UPDATE development_items'));
  assert.match(settled?.sql ?? '', /status = 'planned'/);

  // Ein anderer Auftrag bekommt jetzt seinen eigenen Branch statt eines OrderBranchError.
  const next = await enterOrderBranch(cwd, second, null);
  assert.ok(next);
  assert.notEqual(next.branch, branch.branch);
  await settleItem({ ...ctx, item: second, branch: next }, false, true);

  // Der unterbrochene Auftrag setzt später seinen Branch samt Zwischenstand fort.
  const resumed = await enterOrderBranch(cwd, first, null);
  assert.equal(resumed?.branch, branch.branch);
  assert.equal(await readFile(join(cwd, 'login.ts'), 'utf8'), 'export const login = 1;\n');
});

function contextFor(cwd: string, pool: Pool, branch: unknown, execute = runCommand): RunContext {
  return {
    pool,
    item: first,
    runId: 'run-1',
    options: { cwd, timeoutMs: 1 },
    execute,
    branch,
  } as unknown as RunContext;
}

test('Unterbrechung bei sauberem Ordner: kein leerer Commit, kein gescheiterter Schritt', async () => {
  const { cwd, git } = await project();
  const branch = await enterOrderBranch(cwd, first, null);
  assert.ok(branch);
  const { pool, queries } = recordingPool();
  await settleItem(contextFor(cwd, pool, branch), false, true);
  assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(git('rev-parse', branch.branch), git('rev-parse', 'main'));
  assert.ok(!queries.some((query) => query.sql.includes('INSERT INTO agent_run_steps')));
});

test('Hart beendet nach dem Commit des Schritts: der nächste Auftrag ohne Sprint verlässt den sauberen Branch', async () => {
  const { cwd, git } = await project();
  const branch = await enterOrderBranch(cwd, first, null);
  assert.ok(branch);
  // Commit nach dem Agent lief noch, der Abschluss (settleItem) nicht mehr: Ordner sauber, aber auf auftrag/….
  await writeFile(join(cwd, 'login.ts'), 'export const login = 1;\n');
  git('add', '-A');
  git('commit', '-m', 'Entwickler: Login-Seite');
  const next = await enterOrderBranch(cwd, second, null);
  assert.equal(next?.base, 'main');
  assert.equal(git('symbolic-ref', '--short', 'HEAD'), next?.branch);
  assert.ok(!(await readFile(join(cwd, 'login.ts'), 'utf8').catch(() => null)));
  // Die Arbeit des ersten Auftrags bleibt auf seinem Branch.
  assert.match(git('log', '--format=%s', branch.branch), /Entwickler: Login-Seite/);
});

test('Aufräumen nach der Unterbrechung scheitert: sichtbarer gescheiterter Schritt mit Meldung', async () => {
  const { cwd, git } = await project();
  const branch = await enterOrderBranch(cwd, first, null);
  assert.ok(branch);
  await writeFile(join(cwd, 'login.ts'), 'export const login = 1;\n');
  // Z. B. ein voller Datenträger: jeder Commit scheitert, die Änderungen bleiben im Ordner.
  const execute: typeof runCommand = (command, directory, options) =>
    command[0] === 'git' && command.includes('commit')
      ? Promise.resolve({ exitCode: 1, durationMs: 1, output: 'fatal: No space left on device' })
      : runCommand(command, directory, options);
  const { pool, queries } = recordingPool();
  await settleItem(contextFor(cwd, pool, branch, execute), false, true);
  assert.equal(git('symbolic-ref', '--short', 'HEAD'), branch.branch);
  const step = queries.find((query) => query.sql.includes('INSERT INTO agent_run_steps'));
  assert.ok(step, 'gescheiterter Aufräum-Schritt fehlt');
  assert.equal(step.values[0], 'run-1');
  assert.equal(step.values[1], 'Arbeitsordner aufräumen (Git)');
  assert.match(String(step.values[2]), /offenen Änderungen auf einem Auftrags-Branch/);
  // Der Auftrag bleibt trotzdem eingeplant (kein stummer Neustart, aber auch kein „blockiert“).
  assert.ok(queries.some((query) => /status = 'planned'/.test(query.sql)));
});
