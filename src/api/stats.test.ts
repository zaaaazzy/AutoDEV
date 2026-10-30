import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { collectStats, sprintHitRates } from './stats.js';
import { calibrationFrom, UNCALIBRATED } from '../core/estimate-calibration.js';

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
