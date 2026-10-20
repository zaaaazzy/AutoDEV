import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { collectStats } from './stats.js';

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
