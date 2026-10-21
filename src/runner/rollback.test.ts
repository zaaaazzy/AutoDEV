import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import type { CommandExecutor } from '../core/command.js';
import { runCommand } from '../core/command.js';
import { deployProject, migrationsSince } from './deploy.js';
import { previousSprintTag, sprintTag } from './git-sync.js';
import { deploySuspect } from './production-events.js';
import { checkoutSprintTag, processRollback, type RollbackFacts, rollbackProposal } from './rollback.js';

const TAGS = ['sprint-sprint-1-aaaaaa', 'sprint-sprint-2-bbbbbb', 'sprint-sprint-3-cccccc'];
const facts = (overrides: Partial<RollbackFacts> = {}): RollbackFacts => ({
  source: 'production',
  severity: 'critical',
  deploySuspect: true,
  lastDeploy: { deployedAt: '2026-10-22T10:00:00.000Z', sprintTag: TAGS[2]!, newMigrations: [] },
  tags: TAGS,
  deployRunning: false,
  deployCommands: true,
  separateFolder: true,
  ...overrides,
});

test('Zieltag: unmittelbar vorheriger Sprint-Tag, sonst keiner', () => {
  assert.equal(previousSprintTag(TAGS, TAGS[2]), TAGS[1]);
  assert.equal(previousSprintTag(TAGS, TAGS[1]), TAGS[0]);
  // Ältester Tag, unbekannter Tag, kein Tag: kein Ziel.
  assert.equal(previousSprintTag(TAGS, TAGS[0]), null);
  assert.equal(previousSprintTag(TAGS, 'sprint-weg-dddddd'), null);
  assert.equal(previousSprintTag(TAGS, null), null);
  assert.equal(previousSprintTag([], TAGS[0]), null);
  assert.equal(sprintTag('Sprint 3', 'cccccc00-0000'), TAGS[2]);
});

test('Vorschlag: kritischer Betriebsbug mit Deploy-Verdacht nennt letzten und vorherigen Sprint-Tag', () => {
  assert.deepEqual(rollbackProposal(facts({ lastDeploy: { ...facts().lastDeploy!, newMigrations: ['db/x.sql'] } })), {
    fromTag: TAGS[2],
    toTag: TAGS[1],
    deployedAt: '2026-10-22T10:00:00.000Z',
    disabledReason: null,
    migrations: ['db/x.sql'],
  });
});

test('Vorschlag: ohne Deploy-Verdacht, nicht kritisch oder nicht aus dem Betrieb gibt es keinen Knopf', () => {
  assert.equal(rollbackProposal(facts({ deploySuspect: false })), null);
  assert.equal(rollbackProposal(facts({ severity: 'high' })), null);
  assert.equal(rollbackProposal(facts({ source: 'manual' })), null);
});

test('Vorschlag: Ereignis ausserhalb des 30-Minuten-Fensters nach dem Deploy zeigt keinen Knopf', async () => {
  const deployedAt = new Date('2026-10-22T10:00:00Z');
  const db = { query: async () => ({ rows: [{ deployedAt, orderIds: [] }] }) };
  const outside = await deploySuspect(db as never, 'shop', new Date('2026-10-22T10:31:00Z'));
  assert.equal(outside, null);
  assert.equal(rollbackProposal(facts({ deploySuspect: outside !== null })), null);
  const inside = await deploySuspect(db as never, 'shop', new Date('2026-10-22T10:29:00Z'));
  assert.ok(rollbackProposal(facts({ deploySuspect: inside !== null })));
});

test('Vorschlag: ohne vorherigen Tag oder bei laufendem Deploy ist der Knopf deaktiviert und nennt den Grund', () => {
  const first = rollbackProposal(facts({ lastDeploy: { ...facts().lastDeploy!, sprintTag: TAGS[0]! } }));
  assert.equal(first?.toTag, null);
  assert.equal(first?.disabledReason, 'Kein vorheriger Sprint-Tag vorhanden.');
  const unknown = rollbackProposal(facts({ lastDeploy: null }));
  assert.match(unknown?.disabledReason ?? '', /Sprint-Tag des letzten Deploys ist nicht bekannt/);
  assert.equal(
    rollbackProposal(facts({ deployRunning: true }))?.disabledReason,
    'Es läuft bereits ein Deploy des Projekts.',
  );
  assert.match(rollbackProposal(facts({ deployCommands: false }))?.disabledReason ?? '', /keine Deploy-Befehle/);
  assert.match(
    rollbackProposal(facts({ separateFolder: false }))?.disabledReason ?? '',
    /Agents arbeiten im Projektordner/,
  );
});

/** Repository mit zwei Sprint-Tags; der zweite bringt eine Migration mit. */
async function taggedRepository(): Promise<{ base: string; folder: string; git: (...args: string[]) => string }> {
  const base = await mkdtemp(join(tmpdir(), 'rollback-'));
  const folder = join(base, 'live');
  execFileSync('git', ['init', '-q', '-b', 'main', folder]);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: folder, stdio: 'pipe' }).toString().trim();
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  await writeFile(join(folder, 'app.txt'), 'v1');
  git('add', '-A');
  git('commit', '-q', '-m', 'v1');
  git('tag', TAGS[1]!);
  await mkdir(join(folder, 'migrations'));
  await writeFile(join(folder, 'migrations', '002_neu.sql'), 'ALTER TABLE x ADD y INT;');
  await writeFile(join(folder, 'app.txt'), 'v2');
  git('add', '-A');
  git('commit', '-q', '-m', 'v2');
  git('tag', TAGS[2]!);
  git('checkout', '-q', '--detach', TAGS[2]!);
  return { base, folder, git };
}

test('Migrationshinweis: Migrationen seit dem vorherigen Tag werden erkannt', async (t) => {
  const { base, folder } = await taggedRepository();
  t.after(() => rm(base, { recursive: true, force: true }));
  assert.deepEqual(await migrationsSince(folder, TAGS[1]!), ['migrations/002_neu.sql']);
  assert.equal(await migrationsSince(folder, null), null);
  assert.equal(await migrationsSince(folder, 'sprint-fehlt-000000'), null);
});

test('Tag-Checkout: nur gültige Tags, nie mit offenen Änderungen', async (t) => {
  const { base, folder, git } = await taggedRepository();
  t.after(() => rm(base, { recursive: true, force: true }));
  await assert.rejects(checkoutSprintTag(folder, '--upload-pack=evil'), /Ungültiger Sprint-Tag/);
  await writeFile(join(folder, 'app.txt'), 'lokal geändert');
  await assert.rejects(checkoutSprintTag(folder, TAGS[1]!), /Änderungen offen/);
  assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', `${TAGS[2]}^{commit}`));
});

interface RollbackRow {
  id: string;
  bugId: string;
  fromTag: string;
  toTag: string;
  status: string;
  result: string | null;
}

/** Pool-Attrappe für Worker und Deploy: ein angeforderter Rollback, Deploy-Befehle und abgeschlossene Sprints. */
function rollbackPool(options: { agentsRunning?: boolean; commands?: string[][] | null } = {}) {
  const rollback: RollbackRow = {
    id: 'r-1',
    bugId: 'b-1',
    fromTag: TAGS[2]!,
    toTag: TAGS[1]!,
    status: 'requested',
    result: null,
  };
  const deploys: unknown[][] = [];
  const statements: string[] = [];
  let deployStatus = '';
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      statements.push(sql);
      if (sql.includes("UPDATE production_rollbacks SET status = 'running'")) {
        if (rollback.status !== 'requested' || options.agentsRunning) return { rows: [], rowCount: 0 };
        rollback.status = 'running';
        return { rows: [{ ...rollback }], rowCount: 1 };
      }
      if (sql.includes('UPDATE production_rollbacks SET status = $2')) {
        rollback.status = String(values[1]);
        rollback.result = String(values[2]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT deploy_commands AS commands')) {
        return { rows: [{ commands: options.commands === undefined ? [['true']] : options.commands }] };
      }
      if (sql.includes('SET deploy_status = $2')) deployStatus = String(values[1]);
      if (sql.includes('SELECT deploy_status AS status')) return { rows: [{ status: deployStatus }] };
      if (sql.includes("FROM sprints WHERE project_slug = $1 AND status = 'completed'")) {
        return {
          rows: [
            { id: 'aaaaaa00', name: 'Sprint 1' },
            { id: 'bbbbbb00', name: 'Sprint 2' },
            { id: 'cccccc00', name: 'Sprint 3' },
          ],
        };
      }
      if (sql.includes('INSERT INTO production_deploys')) deploys.push(values);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, rollback, deploys, statements };
}

test('Worker: bestätigter Rollback startet genau einen Deploy auf den Zieltag und protokolliert das Ergebnis', async (t) => {
  const { base, folder, git } = await taggedRepository();
  t.after(() => rm(base, { recursive: true, force: true }));
  const { pool, rollback, deploys, statements } = rollbackPool();
  const deployed: string[] = [];
  const execute: CommandExecutor = async (command, cwd, opts) => {
    if (command[0] !== 'git') {
      deployed.push(`${command.join(' ')}@${git('describe', '--tags', '--exact-match')}`);
      return { exitCode: 0, output: '', durationMs: 1 };
    }
    return runCommand(command, cwd, opts);
  };
  assert.equal(await processRollback(pool, 'shop', folder, join(base, 'agents'), execute), true);
  // Genau ein Deploy (über die Deploy-Befehle des Projekts), ausgeführt auf dem Zieltag.
  assert.deepEqual(deployed, [`true@${TAGS[1]}`]);
  assert.equal(rollback.status, 'succeeded');
  assert.match(rollback.result ?? '', new RegExp(`von ${TAGS[2]} auf ${TAGS[1]} ausgerollt`));
  // Der Deploy hält den Zieltag fest (für den nächsten Vorschlag).
  assert.equal(deploys[0]?.[1], TAGS[1]);
  // Der Bug bleibt unverändert (offen), bis ein Mensch ihn ändert.
  assert.ok(!statements.some((sql) => /UPDATE bugs/i.test(sql)));
  // Ein zweiter Durchlauf findet nichts mehr: kein zweiter Deploy.
  assert.equal(await processRollback(pool, 'shop', folder, join(base, 'agents'), execute), false);
  assert.equal(deployed.length, 1);
});

test('Worker: gescheiterter Deploy steht mit Fehlertext im Protokoll', async (t) => {
  const { base, folder } = await taggedRepository();
  t.after(() => rm(base, { recursive: true, force: true }));
  const { pool, rollback } = rollbackPool({ commands: [['docker', 'compose', 'up', '-d']] });
  const execute: CommandExecutor = async (command, cwd, opts) =>
    command[0] === 'git'
      ? runCommand(command, cwd, opts)
      : { exitCode: 1, output: 'port is already allocated', durationMs: 1 };
  assert.equal(await processRollback(pool, 'shop', folder, join(base, 'agents'), execute), true);
  assert.equal(rollback.status, 'failed');
  assert.match(rollback.result ?? '', /fehlgeschlagen: .*port is already allocated/);
});

test('Worker: ohne eigenen Agent-Ordner oder neben laufenden Agents wird nichts ausgerollt', async (t) => {
  const { base, folder, git } = await taggedRepository();
  t.after(() => rm(base, { recursive: true, force: true }));
  const calls: string[][] = [];
  const execute: CommandExecutor = async (command, cwd, opts) => (
    calls.push(command),
    command[0] === 'git' ? runCommand(command, cwd, opts) : { exitCode: 0, output: '', durationMs: 1 }
  );
  const waiting = rollbackPool({ agentsRunning: true });
  assert.equal(await processRollback(waiting.pool, 'shop', folder, join(base, 'agents'), execute), false);
  assert.equal(waiting.rollback.status, 'requested');
  const shared = rollbackPool();
  assert.equal(await processRollback(shared.pool, 'shop', folder, folder, execute), true);
  assert.equal(shared.rollback.status, 'failed');
  assert.match(shared.rollback.result ?? '', /Agents arbeiten im Projektordner/);
  assert.equal(calls.length, 0);
  assert.equal(git('describe', '--tags', '--exact-match'), TAGS[2]);
});

test('Deploy: hält Sprint-Tag des letzten abgeschlossenen Sprints und neue Migrationen fest', async (t) => {
  const { base, folder } = await taggedRepository();
  t.after(() => rm(base, { recursive: true, force: true }));
  const { pool, deploys, statements } = rollbackPool();
  const execute: CommandExecutor = async (command, cwd, opts) =>
    command[0] === 'git' ? runCommand(command, cwd, opts) : { exitCode: 0, output: '', durationMs: 1 };
  assert.equal(await deployProject(pool, 'shop', folder, execute), true);
  assert.deepEqual(deploys, [['shop', TAGS[2], ['migrations/002_neu.sql']]]);
  // „Deploy läuft“ wird gesetzt und wieder gelöscht.
  assert.ok(statements.some((sql) => sql.includes('deploy_started_at = NOW()')));
  assert.ok(statements.some((sql) => sql.includes('deploy_started_at = NULL')));
});
