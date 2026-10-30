import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import {
  calibratedHours,
  calibratedSql,
  calibratedTokens,
  calibrationFrom,
  calibrationSummary,
  estimateHit,
  estimateOverrun,
  hitRate,
  loadCalibration,
  MIN_CALIBRATION_SAMPLES,
  UNCALIBRATED,
  withCalibratedHours,
} from './estimate-calibration.js';
import { buildUpdate, manualEstimateSql } from './validation.js';
import { AUTHOR_ESTIMATE_SQL, REDRAFT_ORDER_SQL } from '../agent/requirements.js';
import { QUICK_ESTIMATE_SQL } from '../agent/estimation.js';
import { MIGRATIONS, runMigrations } from '../db/migrations.js';
import { adminPool, databaseUrl, dropDatabase, withMigratedDatabase } from '../db/test-database.test.js';

test('Treffer: Stunden und Tokens zwischen 0,5- und 2,0-mal der Schätzung, Grenzen eingeschlossen', () => {
  const estimate = { hours: 1, tokens: 1000 };
  assert.equal(estimateHit({ hours: 1, tokens: 1000 }, estimate), true);
  assert.equal(estimateHit({ hours: 0.5, tokens: 2000 }, estimate), true, 'Grenzen zählen als Treffer');
  assert.equal(estimateHit({ hours: 0.4, tokens: 1000 }, estimate), false, '0,4-mal die Stunden: kein Treffer');
  assert.equal(estimateHit({ hours: 1, tokens: 2001 }, estimate), false, 'Tokens über dem 2-Fachen');
  // Nicht gemessen: Schätzung fehlt oder ist 0, oder es gibt keinen Verbrauch.
  assert.equal(estimateHit({ hours: 1, tokens: 1000 }, { hours: null, tokens: 1000 }), null);
  assert.equal(estimateHit({ hours: 1, tokens: 1000 }, { hours: 1, tokens: 0 }), null);
  assert.equal(estimateHit({ hours: 0, tokens: 0 }, estimate), null);
});

test('Trefferquote: Treffer von gemessenen Aufträgen; ohne Messung null statt 0 %', () => {
  assert.deepEqual(hitRate([true, false, null, true]), { hits: 2, measured: 3, percent: 67 });
  assert.deepEqual(hitRate([null]), { hits: 0, measured: 0, percent: null });
  assert.deepEqual(hitRate([]), { hits: 0, measured: 0, percent: null });
  assert.deepEqual(hitRate([false]), { hits: 0, measured: 1, percent: 0 });
});

test('Überschreitung: erst über dem Dreifachen, je Wert; ohne Schätzung nie', () => {
  const estimate = { hours: 0.5, tokens: 1_000_000 };
  assert.equal(estimateOverrun({ hours: 1.5, tokens: 3_000_000 }, estimate), null, 'genau das Dreifache läuft weiter');
  assert.deepEqual(estimateOverrun({ hours: 0.1, tokens: 3_000_001 }, estimate), { hours: false, tokens: true });
  assert.deepEqual(estimateOverrun({ hours: 1.51, tokens: 10 }, estimate), { hours: true, tokens: false });
  assert.equal(estimateOverrun({ hours: 100, tokens: 1e9 }, { hours: null, tokens: null }), null);
  assert.equal(estimateOverrun({ hours: 100, tokens: 1e9 }, { hours: 0, tokens: 0 }), null);
  // Nur Tokens geschätzt: die Laufzeit wird nicht geprüft.
  assert.equal(estimateOverrun({ hours: 100, tokens: 10 }, { hours: null, tokens: 1000 }), null);
});

test('Faktor-Übersicht: je Herkunft Faktor und Anzahl der Messwerte; unter 5 Messwerten Faktor 1', () => {
  const calibration = calibrationFrom([
    { own: true, source: 'author', hourSamples: 7, hourRatio: 2.5, tokenSamples: 7, tokenRatio: 0.8 },
    { own: true, source: 'quick', hourSamples: 4, hourRatio: 9, tokenSamples: 4, tokenRatio: 9 },
  ]);
  const summary = calibrationSummary(calibration);
  assert.deepEqual(
    summary.map((entry) => entry.source),
    ['manual', 'quick', 'author', 'legacy'],
  );
  assert.deepEqual(summary.find((entry) => entry.source === 'author'), {
    source: 'author',
    label: 'Auftragsautor',
    hours: 2.5,
    tokens: 0.8,
    samples: 7,
    scope: 'project',
  });
  assert.deepEqual(summary.find((entry) => entry.source === 'quick'), {
    source: 'quick',
    label: 'Schnellschätzung',
    hours: 1,
    tokens: 1,
    samples: 0,
    scope: 'default',
  });
});

test('Kalibrierung: erst das Projekt, dann alle Projekte, sonst 1; Stunden und Tokens getrennt, begrenzt', () => {
  const calibration = calibrationFrom([
    { own: true, source: 'legacy', hourSamples: 19, hourRatio: 0.0419, tokenSamples: 19, tokenRatio: 0.85 },
    { own: false, source: 'legacy', hourSamples: 40, hourRatio: 0.05, tokenSamples: 40, tokenRatio: 0.5 },
    // Zu wenig eigene Messwerte: der Wert aller Projekte gilt.
    { own: true, source: 'author', hourSamples: 2, hourRatio: 3, tokenSamples: 2, tokenRatio: 3 },
    { own: false, source: 'author', hourSamples: 8, hourRatio: 0.8, tokenSamples: 3, tokenRatio: 2 },
    // Ausreisser werden auf 0,01–10 begrenzt.
    { own: true, source: 'manual', hourSamples: 6, hourRatio: 0.0001, tokenSamples: 6, tokenRatio: 500 },
  ]);
  assert.deepEqual(calibration.legacy, { hours: 0.042, tokens: 0.85, samples: 19, scope: 'project' });
  assert.deepEqual(calibration.author, { hours: 0.8, tokens: 1, samples: 8, scope: 'all' });
  assert.deepEqual(calibration.manual, { hours: 0.01, tokens: 10, samples: 6, scope: 'project' });
  assert.deepEqual(calibration.quick, UNCALIBRATED.quick);
  assert.equal(MIN_CALIBRATION_SAMPLES, 5);
});

test('Kalibrierte Werte je Herkunft; leere Herkunft ist Altbestand, null bleibt null', () => {
  const calibration = { ...UNCALIBRATED, legacy: { hours: 0.04, tokens: 0.5, samples: 20, scope: 'project' as const } };
  assert.equal(calibratedHours(12, null, calibration), 0.48);
  assert.equal(calibratedHours(0.3, 'author', calibration), 0.3);
  assert.equal(calibratedHours(null, null, calibration), null);
  assert.equal(calibratedTokens(1_000_001, 'unbekannt', calibration), 500_001);
  assert.deepEqual(withCalibratedHours([{ effortHours: 10, estimateSource: null }], calibration), [
    { effortHours: 10, estimateSource: null, calibratedHours: 0.4 },
  ]);
  assert.equal(
    calibratedSql('effort_hours', calibration, 'd'),
    "(d.effort_hours * CASE d.estimate_source WHEN 'manual' THEN 1 WHEN 'quick' THEN 1 WHEN 'author' THEN 1 ELSE 0.04 END)",
  );
});

test('Von Hand geändert: nur geänderte Stunden oder Tokens zählen, Platzhalter wie in buildUpdate', () => {
  assert.equal(manualEstimateSql([{ column: 'title' }, { column: 'benefit' }]), '');
  assert.equal(
    manualEstimateSql([{ column: 'title' }, { column: 'effort_hours' }, { column: 'token_estimate' }]),
    ", estimate_source = CASE WHEN effort_hours IS DISTINCT FROM $3 OR token_estimate IS DISTINCT FROM $4 THEN 'manual' ELSE estimate_source END",
  );
});

/** Erledigter Auftrag mit einem gemessenen Agent-Schritt. */
async function doneOrder(
  pool: pg.Pool,
  project: string,
  estimate: { hours: number; tokens: number; source: string | null },
  actual: { hours: number; tokens: number },
): Promise<void> {
  const order = await pool.query<{ id: string }>(
    `INSERT INTO development_items (project_slug, title, status, effort_hours, token_estimate, estimate_source, completed_at)
     VALUES ($1, 'Erledigt', 'done', $2, $3, $4, NOW()) RETURNING id`,
    [project, estimate.hours, estimate.tokens, estimate.source],
  );
  const run = await pool.query<{ id: string }>(
    `INSERT INTO agent_runs (project_slug, development_id, status) VALUES ($1, $2, 'passed') RETURNING id`,
    [project, order.rows[0]!.id],
  );
  await pool.query(
    `INSERT INTO agent_run_steps (run_id, position, agent_name, phase, status, duration_ms, tokens)
     VALUES ($1, 1, 'Entwickler', 'while_task', 'passed', $2, $3)`,
    [run.rows[0]!.id, Math.round(actual.hours * 3_600_000), actual.tokens],
  );
}

test('Datenbank: Migration, Kalibrierung aus Messwerten und Schutz von Hand eingetragener Schätzungen', async (t) => {
  // Migration 9 auf einer Datenbank mit Altbestand: kleine Schätzungen gelten als Autorschätzung, Kapazität 40 → 4.
  await t.test('Migration ordnet den Altbestand zu und stellt die Kapazität um', async (sub) => {
    const admin = await adminPool(sub);
    if (!admin) return;
    const name = `devlog_calibration_migration_${process.pid}`;
    await dropDatabase(admin, name);
    await admin.query(`CREATE DATABASE ${name}`);
    const pool = new pg.Pool({ connectionString: databaseUrl(name), max: 2 });
    try {
      await runMigrations(
        pool,
        MIGRATIONS.filter((migration) => migration.version < 9),
      );
      await pool.query(`INSERT INTO projects (slug, name, repository, sprint_capacity_hours) VALUES
        ('alt', 'Alt', '/srv/alt', 40), ('eigen', 'Eigen', '/srv/eigen', 12)`);
      await pool.query(`INSERT INTO development_items (project_slug, title, effort_hours) VALUES
        ('alt', 'Klein', 0.3), ('alt', 'Gross', 12), ('alt', 'Ohne', NULL)`);
      await pool.query(`INSERT INTO ideation_items (project_slug, title, effort_hours) VALUES ('alt', 'Idee', 0.5)`);
      await runMigrations(pool);
      const orders = await pool.query(`SELECT title, estimate_source AS source FROM development_items ORDER BY title`);
      assert.deepEqual(orders.rows, [
        { title: 'Gross', source: null },
        { title: 'Klein', source: 'author' },
        { title: 'Ohne', source: null },
      ]);
      const idea = await pool.query(`SELECT estimate_source AS source FROM ideation_items`);
      assert.equal(idea.rows[0]?.source, 'author');
      const projects = await pool.query(`SELECT slug, sprint_capacity_hours AS hours FROM projects ORDER BY slug`);
      assert.deepEqual(projects.rows, [
        { slug: 'alt', hours: 4 },
        { slug: 'eigen', hours: 12 },
      ]);
      await pool.query(`INSERT INTO projects (slug, name, repository) VALUES ('neu', 'Neu', '/srv/neu')`);
      const fresh = await pool.query(`SELECT sprint_capacity_hours AS hours FROM projects WHERE slug = 'neu'`);
      assert.equal(fresh.rows[0]?.hours, 4);
    } finally {
      await pool.end();
      await dropDatabase(admin, name);
      await admin.end();
    }
  });

  await withMigratedDatabase(t, 'devlog_calibration', async (pool) => {
    await pool.query(`INSERT INTO projects (slug, name, repository) VALUES
      ('alpha', 'Alpha', '/srv/alpha'), ('beta', 'Beta', '/srv/beta')`);

    await t.test('Faktor je Herkunft aus den erledigten Aufträgen', async () => {
      for (let index = 0; index < 5; index += 1) {
        // Altbestand: 10 h geschätzt, 0,4 h gemessen; Tokens doppelt so viele wie geschätzt.
        await doneOrder(pool, 'alpha', { hours: 10, tokens: 100_000, source: null }, { hours: 0.4, tokens: 200_000 });
        // Autor in einem anderen Projekt: zu wenig Werte in alpha, also der Wert aller Projekte.
        await doneOrder(
          pool,
          'beta',
          { hours: 0.2, tokens: 100_000, source: 'author' },
          { hours: 0.3, tokens: 50_000 },
        );
      }
      const calibration = await loadCalibration(pool, 'alpha');
      assert.deepEqual(calibration.legacy, { hours: 0.04, tokens: 2, samples: 5, scope: 'project' });
      assert.deepEqual(calibration.author, { hours: 1.5, tokens: 0.5, samples: 5, scope: 'all' });
      assert.deepEqual(calibration.manual, UNCALIBRATED.manual);
    });

    await t.test('Formular ohne Änderung bleibt Maschinenwert, geänderte Stunden werden „manual“', async () => {
      const order = await pool.query<{ id: string }>(
        `INSERT INTO development_items (project_slug, title, effort_hours, token_estimate, estimate_source)
         VALUES ('alpha', 'Offen', 0.3, 1000, 'author') RETURNING id`,
      );
      const id = order.rows[0]!.id;
      const save = async (fields: { column: string; value: unknown }[]) => {
        const update = buildUpdate('development_items', id, fields, 'estimate_source AS source');
        update.sql = update.sql.replace(', updated_at = NOW()', `${manualEstimateSql(fields)}, updated_at = NOW()`);
        return (await pool.query(update.sql, update.values)).rows[0]?.source;
      };
      assert.equal(
        await save([
          { column: 'title', value: 'Offen' },
          { column: 'effort_hours', value: 0.3 },
          { column: 'token_estimate', value: 1000 },
        ]),
        'author',
      );
      assert.equal(await save([{ column: 'effort_hours', value: 0.5 }]), 'manual');
    });

    await t.test('Autor ersetzt Schnellschätzung und Altbestand, nie Werte von Hand', async () => {
      const ideas = await pool.query<{ id: string; title: string }>(
        `INSERT INTO ideation_items (project_slug, title, effort_hours, token_estimate, estimate_source) VALUES
           ('alpha', 'Schnell', 8, 900000, 'quick'),
           ('alpha', 'Alt', 20, NULL, NULL),
           ('alpha', 'Hand', 3, 5000, 'manual'),
           ('alpha', 'Leer', NULL, NULL, NULL)
         RETURNING id, title`,
      );
      for (const idea of ideas.rows) await pool.query(AUTHOR_ESTIMATE_SQL, [idea.id, 0.25, 400_000, 7, 3]);
      const after = await pool.query(
        `SELECT title, effort_hours AS hours, token_estimate::int AS tokens, estimate_source AS source, benefit
           FROM ideation_items WHERE project_slug = 'alpha' ORDER BY title`,
      );
      assert.deepEqual(after.rows, [
        { title: 'Alt', hours: 0.25, tokens: 400_000, source: 'author', benefit: 7 },
        { title: 'Hand', hours: 3, tokens: 5000, source: 'manual', benefit: 7 },
        { title: 'Leer', hours: 0.25, tokens: 400_000, source: 'author', benefit: 7 },
        { title: 'Schnell', hours: 0.25, tokens: 400_000, source: 'author', benefit: 7 },
      ]);

      // Überarbeiten: die neue Autorschätzung geht in den Auftrag, ausser dort wurde von Hand geschätzt.
      const schnell = ideas.rows.find((idea) => idea.title === 'Schnell')!.id;
      const orders = await pool.query<{ id: string; estimate_source: string | null }>(
        `INSERT INTO development_items (project_slug, ideation_id, title, effort_hours, estimate_source) VALUES
           ('alpha', $1, 'Auftrag', 8, 'quick') RETURNING id, estimate_source`,
        [schnell],
      );
      await pool.query(REDRAFT_ORDER_SQL, [orders.rows[0]!.id, 'Neu', '', '']);
      const redrafted = await pool.query(
        `SELECT effort_hours AS hours, estimate_source AS source FROM development_items WHERE id = $1`,
        [orders.rows[0]!.id],
      );
      assert.deepEqual(redrafted.rows[0], { hours: 0.25, source: 'author' });
      await pool.query(`UPDATE development_items SET effort_hours = 2, estimate_source = 'manual' WHERE id = $1`, [
        orders.rows[0]!.id,
      ]);
      await pool.query(REDRAFT_ORDER_SQL, [orders.rows[0]!.id, 'Neu', '', '']);
      const kept = await pool.query(
        `SELECT effort_hours AS hours, estimate_source AS source FROM development_items WHERE id = $1`,
        [orders.rows[0]!.id],
      );
      assert.deepEqual(kept.rows[0], { hours: 2, source: 'manual' });
    });

    await t.test('Schnellschätzung füllt nur Leeres und markiert es als „quick“', async () => {
      const ideas = await pool.query<{ id: string }>(
        `INSERT INTO ideation_items (project_slug, title, effort_hours, estimate_source) VALUES
           ('beta', 'Leer', NULL, NULL), ('beta', 'Hand', 1, 'manual') RETURNING id`,
      );
      for (const idea of ideas.rows) await pool.query(QUICK_ESTIMATE_SQL, [idea.id, 0.4, 20_000, 5, 5]);
      const after = await pool.query(
        `SELECT title, effort_hours AS hours, estimate_source AS source FROM ideation_items
          WHERE project_slug = 'beta' ORDER BY title`,
      );
      assert.deepEqual(after.rows, [
        { title: 'Hand', hours: 1, source: 'manual' },
        { title: 'Leer', hours: 0.4, source: 'quick' },
      ]);
    });
  });
});
