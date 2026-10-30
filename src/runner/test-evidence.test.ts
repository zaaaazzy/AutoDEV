import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import type { CommandExecutor } from '../core/command.js';
import { MIGRATIONS, runMigrations } from '../db/migrations.js';
import { withMigratedDatabase } from '../db/test-database.test.js';
import { EVIDENCE_INSTRUCTIONS, parseEvidence, saveEvidence, stripEvidence } from './acceptance.js';
import { buildPrompt } from './runner-prompts.js';
import { markSprintReady } from './sprint-autopilot.js';
import { evidenceCommand, processTestRequest } from './test-request.js';
import type { WorkflowAgent, WorkItem } from './runner-types.js';

const MARKER =
  '@@NACHWEIS {"datei":"src/a.test.ts","befehl":"npm test -- a","grund":"nicht_freigegeben"}';

test('Nachweis: gültige Markerzeile wird gelesen, unbekannter Grund und unlesbare Zeilen verworfen', () => {
  const output = [
    'Bericht',
    MARKER,
    '@@NACHWEIS {"datei":"src/b.test.ts","befehl":"npm test -- b","grund":"vergessen"}',
    '@@NACHWEIS {"datei":"src/c.test.ts","befehl":"npm test -- c"}',
    '@@NACHWEIS {kaputt',
    '@@NACHWEIS {"datei":"src/a2.test.ts","befehl":"npm test -- a","grund":"gegenprobe_fehlt"}',
    '  @@NACHWEIS {"datei":"","befehl":"npm run lint","grund":"gegenprobe_fehlt"}',
  ].join('\n');
  assert.deepEqual(parseEvidence(output), [
    { datei: 'src/a.test.ts', befehl: 'npm test -- a', grund: 'nicht_freigegeben' },
    { datei: '', befehl: 'npm run lint', grund: 'gegenprobe_fehlt' },
  ]);
  assert.deepEqual(parseEvidence('@@NACHWEIS {"datei":"x","befehl":"npm test","grund":"unbekannt"}'), []);
  assert.deepEqual(parseEvidence('@@NACHWEIS {"datei":"x","befehl":"","grund":"gegenprobe_fehlt"}'), []);
});

test('Nachweis: alle Markerzeilen (auch verworfene) verschwinden aus der Ausgabe bzw. Auftragsdoku', () => {
  const doc = `# Doku\n\nText\n${MARKER}\n@@NACHWEIS {kaputt\nSchluss\n  ${MARKER}`;
  const stripped = stripEvidence(doc);
  assert.doesNotMatch(stripped, /@@NACHWEIS/);
  assert.equal(stripped, '# Doku\n\nText\nSchluss');
});

test('Nachweis: Tester und Dokumentierer bekommen die Anweisung, der Entwickler nicht', () => {
  const item = { id: 'o1', title: 'Auftrag', description: 'x', projectSlug: 'demo' } as unknown as WorkItem;
  const agent = (role: string) =>
    ({ id: role, name: role, role, phase: 'after_task', instructions: '' }) as unknown as WorkflowAgent;
  for (const role of ['tester', 'documenter']) {
    const prompt = buildPrompt(agent(role), item, []);
    assert.ok(prompt.includes(EVIDENCE_INSTRUCTIONS), `${role} kennt @@NACHWEIS`);
    assert.match(prompt, /"grund":"nicht_freigegeben"/);
  }
  assert.ok(!buildPrompt(agent('developer'), item, []).includes('@@NACHWEIS'));
});

/** Pool-Attrappe für processTestRequest mit Umfang „befehl“; merkt sich alle Abfragen. */
function evidencePool(befehl: string, stepFailed: boolean) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes("SET status = 'running'"))
        return { rows: [{ id: 'req-1', scope: 'befehl', evidenceId: 'ev-1' }] };
      if (sql.includes('FROM test_evidence e JOIN development_items')) return { rows: [{ befehl }] };
      if (sql.includes("FROM test_run_steps WHERE run_id = $1 AND status = 'failed'"))
        return { rows: stepFailed ? [{ command: befehl, output: 'rot' }] : [] };
      if (sql.includes('RETURNING bug_count')) return { rows: [{ bugs: 0, runId: 'run-1' }] };
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, queries };
}

const notGit: CommandExecutor = async () => ({ exitCode: 1, durationMs: 0, output: '' });

test('Nachweis-Lauf: erlaubter Befehl startet einen Projekttestlauf als Argumentliste ohne Shell, grün hakt ab', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'evidence-run-'));
  try {
    for (const [failed, status] of [
      [false, 'passed'],
      [true, 'failed'],
    ] as const) {
      const { pool, queries } = evidencePool('npm test -- a', failed);
      let commands: string[][] = [];
      await processTestRequest(pool, { project: 'demo', cwd }, notGit, async (options) => {
        commands = options.commands;
        await options.onRunCreated?.('run-1');
        return 'run-1';
      });
      assert.deepEqual(commands, [['npm', 'test', '--', 'a']], 'genau der gespeicherte Befehl, ohne sh -c');
      const update = queries.find((q) => q.sql.includes('UPDATE test_evidence SET status = $2'));
      assert.deepEqual(update?.params, ['ev-1', status, 'run-1']);
      assert.match(update?.sql ?? '', /checked_at = NOW\(\)/);
      // Kein Bug aus dem Einzelbefehl, Anforderung abgeschlossen.
      assert.ok(!queries.some((q) => q.sql.includes('bug_count = $2')));
      assert.ok(queries.some((q) => q.sql.includes("SET status = 'done'")));
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Nachweis-Lauf: abgelehnter Befehl startet nichts und setzt den Status nicht_freigegeben', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'evidence-refused-'));
  try {
    for (const befehl of ['npx --no-install tsx --test src/a.test.ts', 'npm test; rm -rf /', 'npm test $(whoami)']) {
      const { pool, queries } = evidencePool(befehl, false);
      let started = false;
      const commands: string[] = [];
      const execute: CommandExecutor = async (command) => {
        commands.push(command.join(' '));
        return { exitCode: 1, durationMs: 0, output: '' };
      };
      await processTestRequest(pool, { project: 'demo', cwd }, execute, async () => {
        started = true;
        return 'run-x';
      });
      assert.equal(started, false, `${befehl}: kein Testlauf`);
      assert.deepEqual(commands, [], `${befehl}: kein Befehl, kein Checkout`);
      assert.ok(queries.some((q) => q.sql.includes("SET status = 'nicht_freigegeben'") && q.params[0] === 'ev-1'));
      const failed = queries.find((q) => q.sql.includes("UPDATE test_requests SET status = 'failed'"));
      assert.match(String(failed?.params[1]), /nicht freigegeben/);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Nachweis-Lauf: ohne gespeicherte Zeile kein Befehl', async () => {
  const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
  await assert.rejects(evidenceCommand(pool, 'demo', 'ev-1', '/tmp'), /nicht gefunden/);
  await assert.rejects(evidenceCommand(pool, 'demo', null, '/tmp'), /nicht gefunden/);
});

test('test_evidence: Migration wiederholbar, ein Nachweis je Befehl und Auftrag, kein action_todo, Sprint fertig', async (t) => {
  await withMigratedDatabase(t, 'devlog_test_evidence', async (db) => {
    assert.deepEqual(await runMigrations(db), [], 'zweiter Start ändert nichts');
    // Migration 19 erneut ausgeführt (z. B. nach abgebrochenem Start): ohne Fehler.
    await db.query(MIGRATIONS.find((migration) => migration.version === 19)!.sql);
    await db.query(`INSERT INTO projects (slug, name, repository) VALUES ('shop', 'Shop', '/tmp/shop')`);
    const sprint = (
      await db.query<{ id: string }>(
        `INSERT INTO sprints (project_slug, name, status) VALUES ('shop', 'Sprint 1', 'active') RETURNING id`,
      )
    ).rows[0]!.id;
    const order = (
      await db.query<{ id: string }>(
        `INSERT INTO development_items (project_slug, title, status, sprint_id) VALUES ('shop', 'A', 'done', $1)
         RETURNING id`,
        [sprint],
      )
    ).rows[0]!.id;

    const reported = parseEvidence(`Bericht\n${MARKER}`);
    assert.equal(await saveEvidence(db, order, reported, 'Tester'), 1);
    assert.equal(await saveEvidence(db, order, reported, 'Tester'), 0, 'zweiter Lauf: keine zweite Zeile');
    assert.equal(await saveEvidence(db, order, parseEvidence(MARKER.replace('nicht_freigegeben', 'x'))), 0);
    const rows = (await db.query('SELECT datei, befehl, grund, status, position FROM test_evidence')).rows;
    assert.deepEqual(rows, [
      { datei: 'src/a.test.ts', befehl: 'npm test -- a', grund: 'nicht_freigegeben', status: 'open', position: 1 },
    ]);
    await assert.rejects(
      db.query(`UPDATE test_evidence SET status = 'bogus'`),
      /check/,
      'nur bekannte Status',
    );

    // Offener Nachweis setzt keine Aktion und hält den Sprint nicht auf.
    const todo = (await db.query('SELECT action_todo FROM development_items WHERE id = $1', [order])).rows[0];
    assert.equal(todo.action_todo, null);
    assert.equal(await markSprintReady(db as unknown as Pool, 'shop'), true);

    // Umfang „befehl“ mit Verweis; alle bisherigen Umfänge bleiben erlaubt.
    const evidence = (await db.query<{ id: string }>('SELECT id FROM test_evidence')).rows[0]!.id;
    for (const scope of ['full', 'ui']) {
      await db.query(`INSERT INTO test_requests (project_slug, scope, status) VALUES ('shop', $1, 'done')`, [scope]);
    }
    await db.query(
      `INSERT INTO test_requests (project_slug, scope, status, evidence_id) VALUES ('shop', 'befehl', 'done', $1)`,
      [evidence],
    );
    await assert.rejects(
      db.query(`INSERT INTO test_requests (project_slug, scope) VALUES ('shop', 'datei')`),
      /check/,
    );
    // Auftrag gelöscht: Nachweise gehen mit, die Anforderung bleibt ohne Verweis.
    await db.query('DELETE FROM development_items WHERE id = $1', [order]);
    assert.equal((await db.query('SELECT 1 FROM test_evidence')).rowCount, 0);
    assert.equal((await db.query(`SELECT 1 FROM test_requests WHERE scope = 'befehl'`)).rowCount, 1);
  });
});
