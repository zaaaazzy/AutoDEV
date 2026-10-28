import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { slugify } from '../runner/git-sync/git-helpers.js';
import { MIGRATIONS, runMigrations } from './migrations.js';
import { adminPool, databaseUrl, dropDatabase, withMigratedDatabase } from './test-database.test.js';

const branchOf = async (pool: pg.Pool, id: string): Promise<string | null> =>
  (await pool.query<{ branch: string | null }>('SELECT branch FROM sprints WHERE id = $1', [id])).rows[0]?.branch ??
  null;

test('Sprint-Branch: beim Start festgehalten, Umbenennen ändert ihn nicht, gleicher Name bekommt einen eigenen', async (t) => {
  await withMigratedDatabase(t, 'devlog_sprint_branch', async (pool) => {
    await pool.query(`INSERT INTO projects (slug, name, repository) VALUES ('shop', 'Shop', '/tmp/shop')`);
    const insert = async (name: string) =>
      (
        await pool.query<{ id: string }>(`INSERT INTO sprints (project_slug, name) VALUES ('shop', $1) RETURNING id`, [
          name,
        ])
      ).rows[0]!.id;
    const first = await insert('Sprint 5');
    assert.equal(await branchOf(pool, first), null, 'geplant: noch kein Branch');
    await pool.query(`UPDATE sprints SET name = 'Sprint 5' WHERE id = $1`, [first]);
    await pool.query(`UPDATE sprints SET status = 'active' WHERE id = $1`, [first]);
    assert.equal(await branchOf(pool, first), 'sprint/sprint-5');

    await pool.query(`UPDATE sprints SET name = 'Sprint 5 – Äpfel umbenannt', goal = 'neu' WHERE id = $1`, [first]);
    assert.equal(await branchOf(pool, first), 'sprint/sprint-5', 'Umbenennen lässt den Branch stehen');
    await pool.query(`UPDATE sprints SET status = 'completed' WHERE id = $1`, [first]);
    assert.equal(await branchOf(pool, first), 'sprint/sprint-5');

    // Ein zweiter „Sprint 5“ teilt sich den Branch nicht mehr mit dem ersten.
    const second = await insert('Sprint 5');
    await pool.query(`UPDATE sprints SET status = 'active' WHERE id = $1`, [second]);
    assert.equal(await branchOf(pool, second), `sprint/sprint-5-${second.slice(0, 6)}`);
  });
});

test('Sprint-Branch: SQL-Slug entspricht slugify() im Code', async (t) => {
  await withMigratedDatabase(t, 'devlog_sprint_slug', async (pool) => {
    const names = [
      'Sprint 1: Äpfel',
      'Sprint 5',
      '  --Grüße aus Zürich!--  ',
      'Café crème & Crêpes',
      'ß und Ω',
      '!!!',
      'Ein sehr langer Sprintname, der deutlich über vierzig Zeichen hinausgeht',
    ];
    for (const name of names) {
      const row = (await pool.query<{ slug: string }>('SELECT sprint_branch_slug($1) AS slug', [name])).rows[0];
      assert.equal(row?.slug, slugify(name), name);
    }
  });
});

test('Sprint-Branch-Migration: laufende Sprints behalten ihren Branch, doppelte Namen werden eindeutig', async (t) => {
  const admin = await adminPool(t);
  if (!admin) return;
  const name = `devlog_sprint_branch_legacy_${process.pid}`;
  await dropDatabase(admin, name);
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ connectionString: databaseUrl(name), max: 1 });
  try {
    const version = MIGRATIONS.find((migration) => migration.name === 'sprint-branch-beim-start-festhalten')!.version;
    await runMigrations(
      pool,
      MIGRATIONS.filter((migration) => migration.version < version),
    );
    await pool.query(`INSERT INTO projects (slug, name, repository) VALUES ('shop', 'Shop', '/tmp/shop')`);
    const insert = async (sprint: string, status: string, created: string) =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO sprints (project_slug, name, status, created_at) VALUES ('shop', $1, $2, $3) RETURNING id`,
          [sprint, status, created],
        )
      ).rows[0]!.id;
    const old = await insert('Sprint 5', 'completed', '2026-01-01');
    const active = await insert('Sprint 5', 'active', '2026-02-01');
    const planned = await insert('Sprint 6', 'planned', '2026-03-01');
    const cancelled = await insert('Sprint 4: Äpfel', 'cancelled', '2025-12-01');

    await runMigrations(pool);
    assert.equal(await branchOf(pool, active), 'sprint/sprint-5', 'laufender Sprint behält seinen heutigen Branch');
    assert.equal(await branchOf(pool, old), `sprint/sprint-5-${old.slice(0, 6)}`);
    assert.equal(await branchOf(pool, cancelled), 'sprint/sprint-4-apfel');
    assert.equal(await branchOf(pool, planned), null, 'geplante Sprints bekommen ihn erst beim Start');
    assert.equal((await pool.query('SELECT 1 FROM sprints')).rowCount, 4, 'keine Zeile gelöscht oder neu angelegt');
    // Zweiter Start: nichts mehr auszuführen.
    assert.deepEqual(await runMigrations(pool), []);
  } finally {
    await pool.end();
    await dropDatabase(admin, name);
    await admin.end();
  }
});
