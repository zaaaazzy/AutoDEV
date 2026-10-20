import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { collectQuality } from './quality.js';

test('computes rates from the counts and tolerates an empty project', async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('AS finished')) return { rows: [{ finished: '10', first: '7' }] };
      if (sql.includes('Zurück an den Entwickler')) return { rows: [{ count: '4', succeeded: '3' }] };
      if (sql.includes('Vorübergehender Fehler')) return { rows: [{ count: '2', succeeded: '2' }] };
      if (sql.includes('AS resolved')) return { rows: [{ resolved: '5', avg: '2.345' }] };
      if (sql.includes('AS open')) return { rows: [{ open: '1', longest: '30.04' }] };
      if (sql.includes('Kostengrenze')) return { rows: [{ count: '1' }] };
      return { rows: [{ agent: 'Tester', engine: 'claude', steps: '8', failed: '2' }] };
    },
  } as unknown as Pool;
  const stats = await collectQuality(pool, 'demo');
  assert.equal(stats.orders.firstTryRate, 70);
  assert.equal(stats.corrections.rate, 75);
  assert.equal(stats.transient.rate, 100);
  assert.equal(stats.blocked.avgHours, 2.3);
  assert.equal(stats.agents[0]?.failRate, 25);

  const empty = { query: async () => ({ rows: [] }) } as unknown as Pool;
  const none = await collectQuality(empty, 'leer');
  assert.equal(none.orders.firstTryRate, null);
  assert.equal(none.blocked.avgHours, null);
});
