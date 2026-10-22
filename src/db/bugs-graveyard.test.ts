import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { MIGRATIONS, runMigrations } from './migrations.js';
import { adminPool, databaseUrl, dropDatabase } from './test-database.test.js';

test('Bugs zu einem Auftrag kommen auf den Friedhof, sobald er erledigt ist (Migration 8 und Trigger)', async (t) => {
  const admin = await adminPool(t);
  if (!admin) return;
  const name = `devlog_graveyard_${process.pid}`;
  await dropDatabase(admin, name);
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ connectionString: databaseUrl(name), max: 1 });
  try {
    // Stand vor Migration 8, mit Aufträgen und Meldungen wie in der laufenden Installation.
    const before = MIGRATIONS.filter((migration) => migration.version < 8);
    const client = await pool.connect();
    try {
      await runMigrations(client, before);
    } finally {
      client.release();
    }
    await pool.query(`INSERT INTO projects (slug, name, repository) VALUES ('shop', 'Shop', '/tmp/shop')`);
    const order = async (title: string, status: string): Promise<string> =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO development_items (project_slug, title, status) VALUES ('shop', $1, $2) RETURNING id`,
          [title, status],
        )
      ).rows[0]!.id;
    const bug = async (title: string, description = ''): Promise<string> =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO bugs (project_slug, title, description, severity, source) VALUES ('shop', $1, $2, 'high', 'agent')
           RETURNING id`,
          [title, description],
        )
      ).rows[0]!.id;
    const done = await order('Push-Abos: SSRF verhindern, Besitz prüfen, beim Logout abmelden', 'done');
    const blocked = await order('Lagerverwaltung mit Artikeln und Buchungen', 'blocked');
    const other = await order('Ganz anderer Auftrag', 'planned');
    const lastFailure = await bug('Tester: Push-Abos fehlgeschlagen', 'Neuester Fehlschlag');
    await pool.query(`UPDATE development_items SET failure_bug_id = $2 WHERE id = $1`, [done, lastFailure]);
    const olderFailure = await bug('Entwickler: Push-Abos: SSRF verhindern, Besitz prüfen, beim…', 'älterer Versuch');
    const analysis = await bug(
      'Fehlende Implementierung des Lagermoduls',
      'Aufgetreten bei Auftrag „Lagerverwaltung mit Artikeln und Buchungen“.\n\n## Ursache …',
    );
    const unrelated = await bug('Login-Seite lädt langsam');
    await pool.query(
      `INSERT INTO sprints (project_slug, name, status, git_sync) VALUES ('shop', 'Sprint 18', 'completed', 'done')`,
    );
    const ciBug = (
      await pool.query<{ id: string }>(
        `INSERT INTO bugs (project_slug, title, severity, source) VALUES ('shop', 'CI rot im Pull Request von „Sprint 18“', 'high', 'github')
         RETURNING id`,
      )
    ).rows[0]!.id;

    const client8 = await pool.connect();
    try {
      assert.deepEqual(await runMigrations(client8), [8]);
    } finally {
      client8.release();
    }
    const state = async (id: string) =>
      (
        await pool.query<{ status: string; development_id: string | null }>(
          'SELECT status, development_id FROM bugs WHERE id = $1',
          [id],
        )
      ).rows[0]!;
    // Aufgeräumt: beide Meldungen zum erledigten Auftrag, auch die nur über den gekürzten Titel verknüpfte.
    assert.deepEqual(await state(lastFailure), { status: 'fixed', development_id: done });
    assert.deepEqual(await state(olderFailure), { status: 'fixed', development_id: done });
    // Verknüpft, aber noch offen: Auftrag ist blockiert. Ohne Bezug bleibt offen und unverknüpft.
    assert.deepEqual(await state(analysis), { status: 'open', development_id: blocked });
    assert.deepEqual(await state(unrelated), { status: 'open', development_id: null });
    assert.equal((await state(ciBug)).status, 'fixed', 'CI-Meldung eines gemergten Sprints');

    // Trigger: Der blockierte Auftrag wird erledigt → seine Meldung kommt auf den Friedhof, andere nicht.
    await pool.query(`UPDATE development_items SET status = 'done' WHERE id = $1`, [blocked]);
    assert.equal((await state(analysis)).status, 'fixed');
    await pool.query(`UPDATE development_items SET status = 'done' WHERE id = $1`, [other]);
    assert.equal((await state(unrelated)).status, 'open');
  } finally {
    await pool.end();
    await dropDatabase(admin, name);
    await admin.end();
  }
});
