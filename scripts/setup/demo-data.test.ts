import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import { DEMO_FOLDER, freezeDemoProject, installDemoProject } from './demo-data.js';

/** Pool-Attrappe: zeichnet alle Abfragen auf; `fail` lässt die Abfrage scheitern, die den Text enthält. */
function recordingPool(fail?: string) {
  const statements: { sql: string; values: unknown[] }[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (fail && sql.includes(fail)) throw new Error('kaputt');
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return { pool, statements };
}

test('freezeDemoProject: pausiert den Sprint und schliesst laufende Zustände ab, alles in einer Transaktion', async () => {
  const { pool, statements } = recordingPool();
  await freezeDemoProject(pool, 'velowerk');
  const sql = statements.map((statement) => statement.sql.replace(/\s+/g, ' '));
  assert.equal(sql[0], 'BEGIN');
  assert.equal(sql.at(-1), 'COMMIT');
  // Jede Änderung betrifft nur das Beispielprojekt.
  for (const statement of statements.slice(1, -1)) assert.deepEqual(statement.values, ['velowerk']);
  const all = sql.join('\n');
  assert.match(all, /health_url = NULL, git_remote = NULL, log_services = '\{\}'/);
  assert.match(all, /UPDATE sprints SET paused_at = NOW\(\) .* status = 'active'/);
  assert.match(all, /UPDATE agent_runs SET status = 'failed'/);
  assert.match(all, /agent_id = NULL, auto_run = FALSE/);
  assert.match(all, /UPDATE ideation_items SET status = 'idea'/);
  assert.match(all, /analysis_status = 'done'/);
  assert.match(all, /acceptance_checks SET status = 'open'/);
  assert.match(all, /chat_messages SET status = 'done'/);
});

test('freezeDemoProject: ein Fehler rollt alles zurück', async () => {
  const { pool, statements } = recordingPool('UPDATE agent_runs');
  await assert.rejects(freezeDemoProject(pool), /kaputt/);
  assert.equal(statements.at(-1)!.sql, 'ROLLBACK');
});

test('installDemoProject: vorhandenes Projekt bleibt unverändert, kein Ordner wird angelegt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'demo-root-'));
  const statements: string[] = [];
  const pool = {
    query: async (sql: string) => {
      statements.push(sql);
      return { rows: [{}], rowCount: 1 };
    },
  } as unknown as Pool;
  const lines: string[] = [];
  try {
    assert.equal(await installDemoProject(pool, root, (line) => lines.push(line)), 'exists');
    assert.equal(statements.length, 1);
    assert.match(lines[0]!, /schon vorhanden/);
    await assert.rejects(stat(join(root, DEMO_FOLDER)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
