import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { BUG_CATEGORY_VALUES } from '../core/bug-category-values.js';
import { withMigratedDatabase } from '../db/test-database.test.js';
import { type BugCategoryStats, bugCategoryStats, collectStats, retrospectiveInput, sprintHitRates } from './stats.js';
import { calibrationFrom, UNCALIBRATED } from '../core/estimate-calibration.js';

test('Bugs je Kategorie und Kategorie × Sprint: alle acht Kategorien, „ohne“, Retrospektive mit denselben Zahlen', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('b.bug_category AS category')) {
        return {
          rows: [
            { category: 'ui', sprintId: 's1', sprintName: 'Sprint 1', open: '2', buried: '1' },
            { category: null, sprintId: 's1', sprintName: 'Sprint 1', open: '1', buried: '0' },
            { category: 'ui', sprintId: null, sprintName: null, open: '0', buried: '3' },
            { category: 'ci', sprintId: null, sprintName: null, open: '4', buried: '0' },
          ],
        };
      }
      return { rows: [] };
    },
  } as unknown as Pool;
  const stats = await collectStats(pool, 'mainty');
  const byCategory = stats.bugsByCategory as BugCategoryStats['bugsByCategory'];
  assert.deepEqual(
    byCategory.map((row) => row.category),
    [...BUG_CATEGORY_VALUES, null],
  );
  assert.deepEqual(
    byCategory.find((row) => row.category === 'ui'),
    { category: 'ui', open: 2, buried: 4, total: 6 },
  );
  assert.deepEqual(byCategory.at(-1), { category: null, open: 1, buried: 0, total: 1 });
  assert.equal(
    byCategory.reduce((sum, row) => sum + row.total, 0),
    11,
  );
  const pairs = stats.bugsByCategorySprint as BugCategoryStats['bugsByCategorySprint'];
  assert.deepEqual(pairs[2], { category: 'ui', sprintId: null, sprintName: null, open: 0, buried: 3, total: 3 });
  const sql = queries.find((query) => query.sql.includes('b.bug_category AS category'));
  assert.match(sql?.sql ?? '', /LEFT JOIN sprints/, 'Bugs ohne Sprint zählen mit');
  assert.match(sql?.sql ?? '', /WHERE b\.project_slug = \$1/);
  assert.deepEqual(await retrospectiveInput(pool, 'mainty'), {
    bugsByCategory: stats.bugsByCategory,
    bugsByCategorySprint: stats.bugsByCategorySprint,
  });
});

test('Bugs je Kategorie × Sprint auf PostgreSQL: Summe = alle Bugs, „Kein Sprint“, nur bestätigte Kategorien', async (t) => {
  await withMigratedDatabase(t, 'devlog_stats_bugcat', async (pool) => {
    await pool.query(
      `INSERT INTO projects (slug, name, repository) VALUES ('shop', 'Shop', '/tmp/shop'), ('other', 'Other', '/tmp/o')`,
    );
    const sprint = (
      await pool.query<{ id: string }>(`INSERT INTO sprints (project_slug, name) VALUES ('shop', 'S1') RETURNING id`)
    ).rows[0]!.id;
    await pool.query(
      `INSERT INTO bugs (project_slug, title, status, sprint_id, bug_category, bug_category_suggested, bug_category_state)
       VALUES ('shop', 'a', 'open', $1, 'ui', NULL, 'confirmed'),
              ('shop', 'b', 'fixed', $1, 'ui', NULL, 'confirmed'),
              ('shop', 'c', 'wontfix', NULL, 'api', NULL, 'confirmed'),
              ('shop', 'd', 'in_progress', NULL, NULL, 'ci', 'suggested'),
              ('shop', 'e', 'rejected', $1, NULL, NULL, NULL),
              ('other', 'f', 'open', NULL, 'ui', NULL, 'confirmed')`,
      [sprint],
    );
    const stats = await bugCategoryStats(pool, 'shop');
    const all = Number((await pool.query(`SELECT count(*) FROM bugs WHERE project_slug = 'shop'`)).rows[0].count);
    assert.equal(
      stats.bugsByCategorySprint.reduce((sum, row) => sum + row.total, 0),
      all,
    );
    assert.equal(
      stats.bugsByCategory.reduce((sum, row) => sum + row.total, 0),
      all,
    );
    assert.deepEqual(
      stats.bugsByCategorySprint.map((row) => [row.category, row.sprintName, row.open, row.buried]),
      [
        ['ui', 'S1', 1, 1],
        [null, 'S1', 0, 1],
        ['api', null, 0, 1],
        // Nur vorgeschlagen zählt als „ohne Kategorie“.
        [null, null, 1, 0],
      ],
    );
    assert.deepEqual(await retrospectiveInput(pool, 'shop'), stats);
    const full = await collectStats(pool, 'shop');
    assert.deepEqual(
      [full.bugsByCategory, full.bugsByCategorySprint],
      [stats.bugsByCategory, stats.bugsByCategorySprint],
    );
  });
});

test('Trefferquote je Sprint: Treffer von gemessenen erledigten Aufträgen, mit kalibrierter Schätzung', () => {
  const row = (sprintId: string, hours: number, tokens: number, estHours: number | null = 1) => ({
    sprintId,
    estHours,
    estTokens: '1000',
    source: 'author',
    hours: String(hours),
    tokens: String(tokens),
  });
  const rates = sprintHitRates(
    [
      row('s1', 1, 1000),
      row('s1', 0.4, 1000), // 0,4-mal die Stunden: kein Treffer
      row('s1', 2, 2000),
      row('s1', 5, 5000, null), // ohne Stundenschätzung: nicht gemessen
      row('s2', 9, 1000, null),
    ],
    UNCALIBRATED,
  );
  assert.deepEqual(rates.get('s1'), { hits: 2, measured: 3, percent: 67 });
  assert.deepEqual(rates.get('s2'), { hits: 0, measured: 0, percent: null });
  // Kalibriert: Der Auftragsautor schätzt die Hälfte, Faktor 2 macht aus 1 h eine Schätzung von 2 h.
  const doubled = calibrationFrom([
    { own: true, source: 'author', hourSamples: 5, hourRatio: 2, tokenSamples: 5, tokenRatio: 1 },
  ]);
  assert.deepEqual(sprintHitRates([row('s1', 0.9, 1000)], doubled).get('s1'), { hits: 0, measured: 1, percent: 0 });
  assert.deepEqual(sprintHitRates([row('s1', 1.5, 1000)], doubled).get('s1'), { hits: 1, measured: 1, percent: 100 });
});

test('Statistik: Sprint ohne gemessene Aufträge hat keine Quote (–), dazu Faktor und Messwerte je Herkunft', async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('FROM sprints s LEFT JOIN development_items d'))
        return { rows: [{ id: 's1', name: 'S1', status: 'completed', total: '2', done: '2', hours: '1' }] };
      return { rows: [] };
    },
  } as unknown as Pool;
  const stats = await collectStats(pool, 'mainty');
  const [sprint] = stats.velocity as { hitRate: unknown }[];
  assert.deepEqual(sprint?.hitRate, { hits: 0, measured: 0, percent: null });
  const calibration = stats.calibration as { source: string; samples: number; hours: number }[];
  assert.deepEqual(
    calibration.map((entry) => [entry.source, entry.hours, entry.samples]),
    [
      ['manual', 1, 0],
      ['quick', 1, 0],
      ['author', 1, 0],
      ['legacy', 1, 0],
    ],
  );
});

test('Burndown rechnet Tage in Ortszeit (DEV_LOG_TIMEZONE), nicht in UTC der Datenbank', async () => {
  const previous = process.env.DEV_LOG_TIMEZONE;
  process.env.DEV_LOG_TIMEZONE = 'Europe/Zurich';
  try {
    const queries: { sql: string; values: unknown[] }[] = [];
    const pool = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes("FROM sprints WHERE project_slug = $1 AND status = 'active'")) {
          return { rows: [{ id: 'sprint-1', name: 'S1', startDate: '2026-10-19', endDate: null }] };
        }
        if (sql.includes('generate_series')) return { rows: [{ day: '2026-10-21', remaining: '2' }] };
        return { rows: [] };
      },
    } as unknown as Pool;
    const stats = await collectStats(pool, 'mainty');
    assert.deepEqual((stats.sprint as { burndown: unknown }).burndown, [{ day: '2026-10-21', remaining: 2 }]);

    const sprint = queries.find((query) => query.sql.includes("status = 'active'") && query.sql.includes('startDate'));
    assert.match(sprint?.sql ?? '', /created_at AT TIME ZONE \$2::text/);
    assert.deepEqual(sprint?.values, ['mainty', 'Europe/Zurich']);

    const burn = queries.find((query) => query.sql.includes('generate_series'));
    assert.match(burn?.sql ?? '', /\(completed_at AT TIME ZONE \$4::text\)::date <= days\.day/);
    assert.match(burn?.sql ?? '', /\(NOW\(\) AT TIME ZONE \$4::text\)::date/);
    assert.doesNotMatch(burn?.sql ?? '', /CURRENT_DATE|completed_at::date/);
    assert.equal(burn?.values[3], 'Europe/Zurich');
  } finally {
    if (previous === undefined) delete process.env.DEV_LOG_TIMEZONE;
    else process.env.DEV_LOG_TIMEZONE = previous;
  }
});

type Overrun = { id: string; exceeded: { hours: boolean; tokens: boolean }; ratio: { hours: number | null } };

/** Laufender Auftrag ohne Messwerte anderer Aufträge: Faktor 1, kalibriert = 1 h und 1000 Tokens. */
const running = (id: string, hours: number, tokens: number) => ({
  id,
  title: `Auftrag ${id}`,
  status: 'in_progress',
  kind: 'feature',
  category: 'backend',
  effortHours: 1,
  tokenEstimate: 1000,
  estimateSource: 'author',
  steps: '4',
  hours: String(hours),
  tokens: String(tokens),
});

/** Sprintzeile der Velocity-Abfrage; ohne erledigte, gemessene Aufträge liefert der Median null. */
const sprint = (name: string, hourError: number | null, tokenError: string | null, errorSamples: string) => ({
  name,
  status: hourError === null ? 'active' : 'completed',
  total: '2',
  done: hourError === null ? '0' : '2',
  hours: '1',
  hourError,
  tokenError,
  errorSamples,
});

test('Schätzfehler je Sprint: ältester zuerst, ohne erledigte Aufträge null statt 0; Laufwarnung über 3×', async () => {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('"hourError"')) {
        // Neueste zuerst (ORDER BY created_at DESC), wie aus der Datenbank.
        return {
          rows: [sprint('S3', null, null, '0'), sprint('S2', 2.34567, '0.5', '3'), sprint('S1', 0.04, null, '1')],
        };
      }
      if (sql.includes("d.status IN ('in_progress', 'blocked')")) {
        return {
          rows: [
            running('genau', 3, 3000),
            running('stunden', 3.5, 100),
            running('tokens', 0.5, 3001),
            running('weit', 9, 9),
          ],
        };
      }
      return { rows: [] };
    },
  } as unknown as Pool;
  const stats = await collectStats(pool, 'mainty');

  const velocity = stats.velocity as {
    name: string;
    hourError: number | null;
    tokenError: number | null;
    errorSamples: number;
  }[];
  assert.deepEqual(
    velocity.map((row) => [row.name, row.hourError, row.tokenError, row.errorSamples]),
    [
      ['S1', 0.04, null, 1],
      ['S2', 2.346, 0.5, 3],
      ['S3', null, null, 0],
    ],
  );
  const trendSql = queries.find((sql) => sql.includes('"hourError"')) ?? '';
  assert.match(trendSql, /d\.status = 'done'/, 'nur erledigte Aufträge zählen');
  assert.match(trendSql, /percentile_cont\(0\.5\)/, 'Median, nicht Mittelwert');

  const overruns = stats.overruns as Overrun[];
  assert.deepEqual(
    overruns.map((entry) => [entry.id, entry.exceeded.hours, entry.exceeded.tokens]),
    [
      ['weit', true, false],
      ['stunden', true, false],
      ['tokens', false, true],
    ],
    'genau das Dreifache warnt nicht; Stunden oder Tokens genügen, sortiert nach Überschreitung',
  );
  assert.equal(overruns[1]!.ratio.hours, 3.5);
});

test('Laufwarnung: Fehler bei der Prüfung lässt die Statistik stehen und erzeugt keine Warnung', async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("d.status IN ('in_progress', 'blocked')")) throw new Error('Verbindung weg');
      return { rows: [] };
    },
  } as unknown as Pool;
  const stats = await collectStats(pool, 'mainty');
  assert.deepEqual(stats.overruns, []);
  assert.deepEqual(stats.velocity, []);
});
