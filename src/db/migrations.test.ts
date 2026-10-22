import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { MIGRATIONS, MIGRATION_LOCK, runMigrations, type Migration } from './migrations.js';
import { SCHEMA } from './schema.js';
import { adminPool, databaseUrl } from './test-database.test.js';

/** Verbindung, die jede Abfrage mitschreibt; done = bereits vermerkte Versionen, fail = SQL, das scheitert. */
function fakeClient(done: number[], fail?: string) {
  const queries: string[] = [];
  const client = {
    async query(text: string) {
      queries.push(text);
      if (text === fail) throw new Error('Spalte fehlt');
      if (text.startsWith('SELECT version FROM schema_migrations')) {
        return { rows: done.map((version) => ({ version })) };
      }
      return { rows: [] };
    },
  };
  return { client: client as unknown as Pick<pg.Pool, 'query'>, queries };
}

const steps: Migration[] = [
  { version: 1, name: 'eins', sql: 'CREATE TABLE a ()' },
  { version: 2, name: 'zwei', sql: 'ALTER TABLE a ADD COLUMN IF NOT EXISTS b TEXT' },
];

test('Migrationen: Versionen lückenlos ab 1, Basisschritt ist das bisherige Schema, Index auf agent_run_steps(agent_id)', () => {
  assert.deepEqual(
    MIGRATIONS.map((migration) => migration.version),
    MIGRATIONS.map((_, index) => index + 1),
  );
  assert.equal(MIGRATIONS[0].sql, SCHEMA);
  assert.ok(MIGRATIONS.some((migration) => /ON agent_run_steps \(agent_id\)/.test(migration.sql)));
  // Daten-UPDATEs gehören in eigene Schritte, nicht in den Basisschritt (Anweisungen auf oberster Ebene; die
  // UPDATEs in Trigger-Funktionen sind tiefer eingerückt).
  assert.doesNotMatch(SCHEMA, /^ {2}(UPDATE|DELETE FROM)\s/m);
});

test('Migrationen: ausstehende Schritte laufen je in einer Transaktion unter der Advisory-Sperre', async () => {
  const { client, queries } = fakeClient([1]);
  assert.deepEqual(await runMigrations(client, steps), [2]);
  assert.match(queries[0], /pg_advisory_lock/);
  assert.match(queries.at(-1)!, /pg_advisory_unlock/);
  const begin = queries.indexOf('BEGIN');
  assert.deepEqual(queries.slice(begin, begin + 4), [
    'BEGIN',
    steps[1].sql,
    'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
    'COMMIT',
  ]);
  assert.ok(!queries.includes(steps[0].sql), 'Schritt 1 ist schon vermerkt und läuft nicht erneut');
});

test('Migrationen: auf dem Stand läuft beim Start kein ALTER TABLE und keine Transaktion', async () => {
  const { client, queries } = fakeClient([1, 2]);
  assert.deepEqual(await runMigrations(client, steps), []);
  assert.ok(queries.every((query) => !/ALTER TABLE/i.test(query)));
  assert.ok(!queries.includes('BEGIN'));
});

test('Migrationen: fehlgeschlagener Schritt wird zurückgerollt, nicht vermerkt, die Sperre wird gelöst', async () => {
  const { client, queries } = fakeClient([], steps[1].sql);
  await assert.rejects(runMigrations(client, steps), /Migration 2 \(zwei\) fehlgeschlagen: Spalte fehlt/);
  assert.equal(queries.filter((query) => query.startsWith('INSERT INTO schema_migrations')).length, 1);
  assert.equal(queries.at(-2), 'ROLLBACK');
  assert.match(queries.at(-1)!, /pg_advisory_unlock/);
});

/** Struktur der Datenbank: Spalten, Prüfungen, Indizes, Trigger, Funktionen und vermerkte Migrationen. */
async function structure(pool: pg.Pool): Promise<Record<string, unknown[]>> {
  const rows = async (sql: string) => (await pool.query(sql)).rows;
  return {
    columns: await rows(`SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2`),
    constraints: await rows(`SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`),
    indexes: await rows(
      `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2`,
    ),
    triggers: await rows(`SELECT tgrelid::regclass::text AS tbl, tgname, pg_get_triggerdef(oid) AS def
      FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`),
    functions: await rows(`SELECT proname, md5(prosrc) AS body FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace ORDER BY 1`),
    migrations: await rows('SELECT version, name FROM schema_migrations ORDER BY version'),
  };
}

test('Migrationen: frische DB = migrierte Bestands-DB, zweiter Start ändert nichts', async (t) => {
  const admin = await adminPool(t);
  if (!admin) return;
  const names = [`devlog_migr_fresh_${process.pid}`, `devlog_migr_legacy_${process.pid}`];
  const pools: pg.Pool[] = [];
  try {
    for (const name of names) {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${name}`);
      pools.push(new pg.Pool({ connectionString: databaseUrl(name), max: 1 }));
    }
    const [fresh, legacy] = pools;

    // Bestands-DB: so, wie der alte Start sie hinterlassen hat (ganzes Schema samt Daten-UPDATEs, ohne
    // schema_migrations), mit Altdaten, die die Daten-Migration einmalig umzieht.
    await legacy.query(MIGRATIONS[0].sql + MIGRATIONS[1].sql);
    await legacy.query(`INSERT INTO projects (slug, name, repository) VALUES ('shop', 'Shop', '/tmp/shop')`);
    await legacy.query(`INSERT INTO bugs (project_slug, title, source) VALUES ('shop', 'Issue', 'github')`);
    await legacy.query(`INSERT INTO app_settings (key, value) VALUES ('model:developer', 'opus')`);

    const all = MIGRATIONS.map((migration) => migration.version);
    assert.deepEqual(await runMigrations(fresh), all);
    const legacyClient = await legacy.connect();
    try {
      assert.deepEqual(await runMigrations(legacyClient), all);
      // Zweiter Start: nichts mehr auszuführen.
      assert.deepEqual(await runMigrations(legacyClient), []);
    } finally {
      legacyClient.release();
    }

    assert.deepEqual(await structure(legacy), await structure(fresh));
    const settings = await legacy.query(`SELECT model FROM system_agent_settings WHERE role = 'developer'`);
    assert.deepEqual(settings.rows, [{ model: 'opus' }]);
    assert.equal((await legacy.query(`SELECT 1 FROM app_settings WHERE key LIKE 'model:%'`)).rowCount, 0);
    assert.equal((await legacy.query(`SELECT 1 FROM bugs WHERE source = 'github'`)).rowCount, 1);

    // Daten-Migration läuft nicht erneut: ein neuer alter Schlüssel bleibt beim nächsten Start liegen.
    await legacy.query(`INSERT INTO app_settings (key, value) VALUES ('model:tester', 'haiku')`);
    assert.deepEqual(await runMigrations(legacy), []);
    assert.equal((await legacy.query(`SELECT 1 FROM app_settings WHERE key = 'model:tester'`)).rowCount, 1);
    const lock = await legacy.query('SELECT count(*)::int AS n FROM pg_locks WHERE locktype = $1 AND objid = $2', [
      'advisory',
      MIGRATION_LOCK,
    ]);
    assert.equal(lock.rows[0].n, 0, 'Sperre nach dem Lauf gelöst');
  } finally {
    for (const pool of pools) await pool.end();
    for (const name of names) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});
