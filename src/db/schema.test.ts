import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { MIGRATIONS, runMigrations } from './migrations.js';
import { adminPool, databaseUrl, dropDatabase, withMigratedDatabase } from './test-database.test.js';

// Bestands-Datenbanken holen den Basisschritt auf vorhandenen Zeilen nach. Jede Fassung von bugs_source_check (in
// allen Migrationen, in Reihenfolge) wird dabei geprüft; fehlt in einer Fassung ein Wert wie 'github', scheitert der Start.
test('bugs_source_check: jede Fassung erlaubt alle Quellen, die der Code schreibt (auch github)', () => {
  const sql = MIGRATIONS.map((migration) => migration.sql).join('\n');
  const versions = [...sql.matchAll(/ADD CONSTRAINT bugs_source_check\s+CHECK \(source IN \(([^)]*)\)\)/g)].map(
    (match) => [...match[1].matchAll(/'([^']+)'/g)].map((value) => value[1]),
  );
  assert.ok(versions.length >= 1);
  for (const [index, sources] of versions.entries()) {
    assert.ok(sources.includes('github'), `Fassung ${index + 1} von bugs_source_check enthält 'github' nicht`);
  }
  // Spätere Fassungen dürfen nichts entfernen.
  for (let index = 1; index < versions.length; index += 1) {
    for (const source of versions[index - 1]) {
      assert.ok(versions[index].includes(source), `Fassung ${index + 1} verliert '${source}'`);
    }
  }
});

// Gleiches Problem bei jeder mehrfach definierten Prüfung: Eine Zwischenfassung ohne einen später ergänzten Wert
// (z. B. Sprint-Status 'cancelled') lässt den Start scheitern, sobald eine Zeile diesen Wert trägt.
test('Mehrfach definierte CHECK-Listen: jede Fassung erlaubt alle Werte der letzten', () => {
  const versions = new Map<string, string[][]>();
  // Über alle Migrationen in Reihenfolge: so läuft es auf einer Bestands-Datenbank.
  const sql = MIGRATIONS.map((migration) => migration.sql).join('\n');
  for (const match of sql.matchAll(/ADD CONSTRAINT (\w+)\s+CHECK \(\w+ IN \(([^)]*)\)\)/g)) {
    const values = [...match[2].matchAll(/'([^']+)'/g)].map((value) => value[1]);
    versions.set(match[1], [...(versions.get(match[1]) ?? []), values]);
  }
  assert.ok(versions.has('sprints_status_check'));
  for (const [name, lists] of versions) {
    const last = lists.at(-1)!;
    for (const [index, values] of lists.entries()) {
      for (const value of last) {
        assert.ok(values.includes(value), `${name}: Fassung ${index + 1} erlaubt '${value}' nicht`);
      }
    }
  }
});

type Bug = { status: string; fixed_at: Date | null };

async function bugOf(db: Pick<pg.Pool, 'query'>, id: string): Promise<Bug> {
  return (await db.query<Bug>('SELECT status, fixed_at FROM bugs WHERE id = $1', [id])).rows[0];
}

async function bugOrder(db: Pick<pg.Pool, 'query'>, orderStatus: string): Promise<{ bug: string; order: string }> {
  await db.query(
    `INSERT INTO projects (slug, name, repository) VALUES ('shop', 'Shop', '/tmp/shop') ON CONFLICT DO NOTHING`,
  );
  const bug = (
    await db.query<{ id: string }>(`INSERT INTO bugs (project_slug, title) VALUES ('shop', 'Bug') RETURNING id`)
  ).rows[0].id;
  const order = (
    await db.query<{ id: string }>(
      `INSERT INTO development_items (project_slug, title, kind, status, bug_id) VALUES ('shop', 'Bug: x', 'bug', $1, $2)
       RETURNING id`,
      [orderStatus, bug],
    )
  ).rows[0].id;
  return { bug, order };
}

// Abgelehnter Bug-Auftrag, angepasst und erneut versucht (POST /retry setzt planned): Der Bug darf nicht auf
// „abgelehnt“ hängen bleiben, sondern folgt dem Auftrag bis „behoben“ mit fixed_at.
test('Bug-Trigger: rejected → planned → in_progress → done behebt den Bug, auch beim zweiten Versuch', async (t) => {
  await withMigratedDatabase(t, 'devlog_bug_retry', async (db) => {
    const { bug, order } = await bugOrder(db, 'in_progress');
    const move = (status: string) =>
      db.query('UPDATE development_items SET status = $2 WHERE id = $1', [order, status]);
    await db.query(`UPDATE bugs SET status = 'in_progress' WHERE id = $1`, [bug]);

    await move('rejected');
    assert.equal((await bugOf(db, bug)).status, 'rejected');
    await move('planned');
    assert.equal((await bugOf(db, bug)).status, 'open');
    await move('in_progress');
    assert.equal((await bugOf(db, bug)).status, 'in_progress');
    // Zweiter Durchlauf: wieder abgelehnt und erneut versucht.
    await move('rejected');
    await move('planned');
    await move('in_progress');
    await move('done');
    const fixed = await bugOf(db, bug);
    assert.equal(fixed.status, 'fixed');
    assert.ok(fixed.fixed_at, 'fixed_at ist gesetzt');
    // Bug-Liste und Statistik zählen ihn als behoben.
    const counts = await db.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM bugs WHERE project_slug = 'shop' GROUP BY status`,
    );
    assert.deepEqual(counts.rows, [{ status: 'fixed', n: 1 }]);

    // Direkt aus rejected erledigt: ebenfalls behoben.
    const direct = await bugOrder(db, 'rejected');
    await db.query(`UPDATE bugs SET status = 'rejected' WHERE id = $1`, [direct.bug]);
    await db.query(`UPDATE development_items SET status = 'done' WHERE id = $1`, [direct.order]);
    assert.equal((await bugOf(db, direct.bug)).status, 'fixed');
  });
});

test('Bug-Trigger: von Hand abgelehnter Bug bleibt abgelehnt, solange sein Auftrag nicht wieder eingeplant wird', async (t) => {
  await withMigratedDatabase(t, 'devlog_bug_manual', async (db) => {
    const { bug, order } = await bugOrder(db, 'planned');
    await db.query(`UPDATE bugs SET status = 'rejected' WHERE id = $1`, [bug]);
    await db.query(`UPDATE development_items SET status = 'blocked' WHERE id = $1`, [order]);
    await db.query(`UPDATE development_items SET status = 'in_progress' WHERE id = $1`, [order]);
    await db.query(`UPDATE development_items SET title = 'Bug: y' WHERE id = $1`, [order]);
    assert.equal((await bugOf(db, bug)).status, 'rejected');

    // Abgelehnte Fehlschlag-Meldung eines anderen Auftrags bleibt beim Erledigen abgelehnt.
    const other = await bugOrder(db, 'in_progress');
    const report = (
      await db.query<{ id: string }>(
        `INSERT INTO bugs (project_slug, title, status, source, development_id) VALUES ('shop', 'Tester: x', 'rejected', 'agent', $1)
         RETURNING id`,
        [other.order],
      )
    ).rows[0].id;
    await db.query(`UPDATE development_items SET status = 'done' WHERE id = $1`, [other.order]);
    assert.equal((await bugOf(db, report)).status, 'rejected');
    assert.equal((await bugOf(db, other.bug)).status, 'fixed');
  });
});

// Bestands-Datenbank auf Version 10: Migration 11 ersetzt den Trigger und zieht nur Bugs nach, die abgelehnt sind,
// obwohl ihr Auftrag erledigt ist.
test('Migration 11: ersetzt den Bug-Trigger auf Version 10 und zieht abgelehnte Bugs erledigter Aufträge nach', async (t) => {
  const admin = await adminPool(t);
  if (!admin) return;
  const name = `devlog_bug_migration_${process.pid}`;
  await dropDatabase(admin, name);
  await admin.query(`CREATE DATABASE ${name}`);
  const db = new pg.Pool({ connectionString: databaseUrl(name), max: 2 });
  try {
    await runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version <= 10),
    );
    const stale = await bugOrder(db, 'done');
    await db.query(`UPDATE bugs SET status = 'rejected' WHERE id = $1`, [stale.bug]);
    const open = await bugOrder(db, 'rejected');
    await db.query(`UPDATE bugs SET status = 'rejected' WHERE id = $1`, [open.bug]);

    assert.deepEqual(
      await runMigrations(db),
      MIGRATIONS.filter((m) => m.version > 10).map((m) => m.version),
    );
    const fixed = await bugOf(db, stale.bug);
    assert.equal(fixed.status, 'fixed');
    assert.ok(fixed.fixed_at);
    assert.equal((await bugOf(db, open.bug)).status, 'rejected');

    // Neue Fassung des Triggers ist aktiv.
    await db.query(`UPDATE development_items SET status = 'planned' WHERE id = $1`, [open.order]);
    assert.equal((await bugOf(db, open.bug)).status, 'open');
  } finally {
    await db.end();
    await dropDatabase(admin, name);
    await admin.end();
  }
});
