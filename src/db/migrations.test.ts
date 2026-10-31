import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { MIGRATIONS, MIGRATION_LOCK, runMigrations, type Migration } from './migrations.js';
import { SCHEMA } from './schema.js';
import { coverageHistory, coverageOverview } from '../api/coverage.js';
import { COVERAGE_AREA_ALIASES, COVERAGE_AREA_KEYS, coverageAreaKey } from '../core/coverage-areas.js';
import { adminPool, databaseUrl, dropDatabase } from './test-database.test.js';

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
  const versions = MIGRATIONS.map((migration) => migration.version);
  assert.deepEqual(
    versions,
    versions.map((_, index) => index + 1),
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

// Das Basis-Schema (Version 1) läuft nur auf neuen Datenbanken. Was dort nachträglich ergänzt wird, fehlt jeder
// bestehenden Datenbank (so fehlte budget_role_limits, Migration 17). Neue Tabellen und Spalten gehören in eine neue
// Migration; erst dann darf dieser Hash angepasst werden.
test('Migrationen: Basis-Schema ist eingefroren, Änderungen brauchen eine neue Migration', () => {
  assert.equal(
    createHash('sha256').update(SCHEMA).digest('hex'),
    '4ae610239349cb361a95dfd6182047e1c9999bcd18a0d5fb60e89c63cd4ada64',
    'src/db/schema.ts wurde geändert: die Änderung als neue Migration in src/db/migrations.ts anlegen.',
  );
});

test('Migration 26: legt nur den Wartungsjob bug_categories an und ändert keine Bugs', () => {
  const migration = MIGRATIONS.find((step) => step.version === 26);
  assert.equal(migration?.name, 'bug-kategorien-nachtragen');
  assert.match(
    migration?.sql ?? '',
    /INSERT INTO scheduled_jobs[\s\S]*'bug_categories'[\s\S]*ON CONFLICT \(key\) DO NOTHING/,
  );
  assert.doesNotMatch(migration?.sql ?? '', /\bbugs\b/);
});

test('Migrationen: Budget je Rolle kommt per Migration auch in bestehende Datenbanken', () => {
  const migration = MIGRATIONS.find((step) => step.version === 17);
  assert.match(migration?.sql ?? '', /CREATE TABLE IF NOT EXISTS budget_role_limits/);
  assert.match(migration?.sql ?? '', /ADD COLUMN IF NOT EXISTS budget_blocked_role/);
});

test('Migration 25: Zuordnungstabelle enthält genau die Schreibweisen aus COVERAGE_AREA_ALIASES', () => {
  const migration = MIGRATIONS.find((step) => step.version === 25);
  assert.equal(migration?.name, 'coverage-feste-bereiche');
  const pairs = Object.fromEntries(
    [...(migration?.sql ?? '').matchAll(/\('([^']+)', '([^']+)'\)/g)].map((match) => [match[1], match[2]]),
  );
  assert.deepEqual(pairs, COVERAGE_AREA_ALIASES);
  for (const area of COVERAGE_AREA_KEYS) assert.match(migration?.sql ?? '', new RegExp(`'${area}'`));
  // Nichts wird gelöscht außer den zusammengeführten Zeilen mit Zuordnung (sie kommen zusammengefasst wieder hinein).
  assert.equal((migration?.sql ?? '').match(/DELETE FROM/g)?.length, 1);
  assert.match(migration?.sql ?? '', /USING coverage_area_aliases/);
});

test('Migration 25: Bereiche umschreiben, Kollisionen zusammenführen, Altbestand ohne Zuordnung behalten', async (t) => {
  const admin = await adminPool(t);
  if (!admin) return;
  const name = `devlog_migr_cov_${process.pid}`;
  await dropDatabase(admin, name);
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ connectionString: databaseUrl(name), max: 1 });
  const client = await pool.connect();
  try {
    // Stand vor Version 25 mit Altbestand: zwei Schreibweisen für backend im selben Bericht, fehlender Zeilenwert,
    // ein Bereich ohne Zuordnung. Der CHECK aus Migration 24 wird dafür entfernt (Altbestand vor 23 / Fremddaten).
    await runMigrations(
      client,
      MIGRATIONS.filter((step) => step.version < 25),
    );
    assert.equal((await client.query(`SELECT to_regclass('coverage_area_aliases') AS t`)).rows[0].t, null);
    await client.query('ALTER TABLE test_coverage_areas DROP CONSTRAINT test_coverage_areas_area_check');
    await client.query(`INSERT INTO projects (slug, name, repository) VALUES ('shop', 'Shop', '/tmp/shop')`);
    const report = (
      await client.query<{ id: string }>(
        `INSERT INTO test_coverage_reports (project_slug, summary) VALUES ('shop', 'alt') RETURNING id`,
      )
    ).rows[0]!.id;
    await client.query(
      `INSERT INTO test_coverage_areas (report_id, area, unit_tests, passed, lines, branches) VALUES
         ($1, 'Backend', 10, 10, 80, 60), ($1, ' backend (src) ', 4, 4, 70, NULL),
         ($1, 'Frontend', 3, 3, NULL, 50), ($1, 'Sonstiges', 2, 2, 90, 90), ($1, 'Order', 1, 1, 50, 40)`,
      [report],
    );

    assert.deepEqual(await runMigrations(client), [25, 26]);
    const rows = (
      await client.query(
        `SELECT area, unit_tests AS unit, passed, lines, branches FROM test_coverage_areas
          WHERE report_id = $1 ORDER BY lower(area)`,
        [report],
      )
    ).rows;
    assert.deepEqual(rows, [
      { area: 'auftrag', unit: 1, passed: 1, lines: 50, branches: 40 },
      // Fehlt der Zweigwert in einem der beiden Einträge, bleibt eine Lücke (kein Mittel aus dem Rest).
      { area: 'backend', unit: 14, passed: 14, lines: 75, branches: null },
      { area: 'frontend', unit: 3, passed: 3, lines: null, branches: 50 },
      { area: 'Sonstiges', unit: 2, passed: 2, lines: 90, branches: 90 },
    ]);
    const versions = (await client.query('SELECT version FROM schema_migrations WHERE version = 24')).rowCount;
    assert.equal(versions, 1, 'Version 25 vermerkt');
    // Neue Zeilen nur mit festen Namen; der Altbestand ohne Zuordnung bleibt trotzdem stehen.
    await assert.rejects(
      client.query(`INSERT INTO test_coverage_areas (report_id, area) VALUES ($1, 'Neu')`, [report]),
      /test_coverage_areas_area_check/,
    );
    // Zweiter Start: läuft nicht erneut.
    assert.deepEqual(await runMigrations(client), []);
  } finally {
    client.release();
    await pool.end();
    await dropDatabase(admin, name);
    await admin.end();
  }
});

test('Migrationen: Testabdeckung auf feste Bereichsschlüssel (Schritt 24)', () => {
  const migration = MIGRATIONS.find((step) => step.version === 24);
  assert.equal(migration?.name, 'testabdeckung-feste-bereiche');
  // Sicherung vor dem Löschen, CHECK erst nach dem Bereinigen.
  const sql = migration?.sql ?? '';
  assert.ok(sql.indexOf('test_coverage_areas_backup_24') < sql.indexOf('DELETE FROM test_coverage_areas'));
  assert.ok(sql.lastIndexOf('DELETE FROM') < sql.indexOf('ADD CONSTRAINT test_coverage_areas_area_check'));
});

/** Bezeichnungen aus Altbeständen; die SQL-Zuordnung muss coverageAreaKey entsprechen. */
const LEGACY_LABELS = [
  'Backend',
  'Backend (Express)',
  'API-Server',
  'Frontend',
  'Frontend (Angular)',
  'shop-ui',
  'Contracts/Shared',
  'Scripts',
  'Skripte',
  'E2E (Playwright)',
  'Gesamt',
  'Insgesamt',
  'Backend und Frontend (zusammen)',
  'Backend + Frontend',
  'Projekt',
  'dev-log',
  'builder',
  'Gesamtprojekt',
];

test('Migrationen 24 und 25: Altbestand wird zugeordnet, bereinigt, abgesichert; zweiter Start ändert nichts', async (t) => {
  const admin = await adminPool(t);
  if (!admin) return;
  const name = `devlog_migr_coverage_${process.pid}`;
  await dropDatabase(admin, name);
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ connectionString: databaseUrl(name), max: 1 });
  try {
    const client = await pool.connect();
    try {
      await runMigrations(
        client,
        MIGRATIONS.filter((step) => step.version < 24),
      );
      await client.query(`INSERT INTO projects (slug, name, repository) VALUES ('shop', 'Shop', '/tmp/shop')`);
      const report = async (summary: string, createdAt: string) =>
        (
          await client.query<{ id: string }>(
            `INSERT INTO test_coverage_reports (project_slug, summary, created_at) VALUES ('shop', $1, $2) RETURNING id`,
            [summary, createdAt],
          )
        ).rows[0]!.id;
      const area = (id: string, label: string, lines: number | null, branches: number | null, fns: number | null) =>
        client.query(
          `INSERT INTO test_coverage_areas (report_id, area, lines, branches, functions) VALUES ($1, $2, $3, $4, $5)`,
          [id, label, lines, branches, fns],
        );
      const older = await report('älter', '2026-10-01T10:00:00Z');
      await area(older, 'Backend', 70, 60, 80);
      await area(older, 'Backend (Express)', 60, 50, 70); // gleicher Schlüssel: der höhere Zeilenwert bleibt
      await area(older, 'Frontend', null, null, null); // ohne Prozentwerte
      await area(older, 'Projekt', 50, 40, 60); // nicht zuordenbar
      await area(older, 'Contracts/Shared', 90, 80, 95);
      const newer = await report('neuer', '2026-10-20T10:00:00Z');
      await area(newer, 'backend', 85, null, 90); // unvollständig: bleibt, zählt aber nicht als neuester Lauf
      await area(newer, 'Backend und Frontend (zusammen)', 75, 65, 85);
      await area(newer, 'Frontend (Angular)', 66, 55, 77);
      for (const label of LEGACY_LABELS) await area(await report(label, '2026-09-01T10:00:00Z'), label, 50, 50, 50);

      // 24 schreibt über die Zuordnungstabelle um; nach 23 ist alles schon zugeordnet, es ändert sich nichts.
      assert.deepEqual(await runMigrations(client), [24, 25, 26]);

      const rows = async (id: string) =>
        (await client.query('SELECT area, lines FROM test_coverage_areas WHERE report_id = $1 ORDER BY area', [id]))
          .rows;
      assert.deepEqual(await rows(older), [
        { area: 'backend', lines: 70 },
        { area: 'contracts', lines: 90 },
      ]);
      assert.deepEqual(await rows(newer), [
        { area: 'backend', lines: 85 },
        { area: 'frontend', lines: 66 },
        { area: 'gesamt', lines: 75 },
      ]);
      // SQL-Zuordnung = coverageAreaKey.
      const mapped = await client.query<{ summary: string; area: string | null }>(
        `SELECT r.summary, a.area FROM test_coverage_reports r LEFT JOIN test_coverage_areas a ON a.report_id = r.id
          WHERE r.created_at = '2026-09-01T10:00:00Z'`,
      );
      for (const row of mapped.rows) assert.equal(row.area, coverageAreaKey(row.summary), row.summary);
      const backup = await client.query('SELECT count(*)::int AS n FROM test_coverage_areas_backup_24');
      assert.equal(backup.rows[0].n, 8 + LEGACY_LABELS.length, 'Sicherung mit allen Altzeilen');

      // Jede Zeile hat einen festen Schlüssel; jeder Schlüssel aus dem Code besteht den CHECK, andere nicht.
      const keys = await client.query<{ area: string }>('SELECT DISTINCT area FROM test_coverage_areas');
      for (const row of keys.rows) assert.ok((COVERAGE_AREA_KEYS as readonly string[]).includes(row.area), row.area);
      const probe = await report('probe', '2026-08-01T10:00:00Z');
      for (const key of COVERAGE_AREA_KEYS) await area(probe, key, 1, 1, 1);
      await assert.rejects(area(probe, 'Frontend', 1, 1, 1), /test_coverage_areas_area_check/);
      await client.query('DELETE FROM test_coverage_reports WHERE id = $1', [probe]);

      // Übersicht und Verlauf: neuester vollständiger Lauf je Schlüssel, Verlauf mit Datum.
      const overview = await coverageOverview(client, 'shop');
      assert.deepEqual(
        overview?.areas.map((row) => [row.area, row.lines, row.complete]),
        [
          ['backend', 70, true],
          ['frontend', 66, true],
          ['contracts', 90, true],
          ['scripts', 50, true],
          ['e2e', 50, true],
          ['gesamt', 75, true],
        ],
      );
      const history = await coverageHistory(client, 'shop');
      const backend = history.filter((point) => point.area === 'backend');
      assert.deepEqual(
        backend.map((point) => point.lines),
        [50, 50, 50, 70],
        'nur vollständige Läufe, aufsteigend nach Datum',
      );
      assert.ok(
        backend.every((point) => !Number.isNaN(new Date(point.createdAt).getTime())),
        'Datum je Punkt',
      );

      // Zweiter Start: keine Migration, Abdeckungsdaten unverändert.
      const before = (await client.query('SELECT * FROM test_coverage_areas ORDER BY report_id, area')).rows;
      assert.deepEqual(await runMigrations(client), []);
      assert.deepEqual((await client.query('SELECT * FROM test_coverage_areas ORDER BY report_id, area')).rows, before);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
    await dropDatabase(admin, name);
    await admin.end();
  }
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
      await dropDatabase(admin, name);
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
    // pg_locks zeigt den ganzen Cluster: nur diese Datenbank zählen, andere Testdateien migrieren parallel.
    const lock = await legacy.query(
      `SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = $1 AND objid = $2 AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      ['advisory', MIGRATION_LOCK],
    );
    assert.equal(lock.rows[0].n, 0, 'Sperre nach dem Lauf gelöst');
  } finally {
    for (const pool of pools) await pool.end();
    for (const name of names) await dropDatabase(admin, name);
    await admin.end();
  }
});

test('Migrationen: Restore-Probe kommt per Migration auch in bestehende Datenbanken', () => {
  const migration = MIGRATIONS.find((step) => step.version === 22);
  assert.match(migration?.sql ?? '', /'restore_probe', TRUE, 604800, 'restore_probe'/);
  assert.match(migration?.sql ?? '', /ON CONFLICT \(key\) DO NOTHING/);
});
