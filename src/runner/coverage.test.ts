import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { parseCoverage, saveCoverage, stripCoverage } from './coverage.js';

const BLOCK =
  '@@COVERAGE {"summary":"3 Tests ergänzt","areas":[{"area":"Frontend","unit":100,"component":36,"integration":0,"e2e":2,"passed":138,"failed":0,"lines":81.4,"statements":80.9,"branches":62,"functions":"74.5"},{"area":"Backend","unit":50,"integration":19,"lines":null}]}';

test('parses the tester coverage block per area', () => {
  const report = parseCoverage(`Alle Tests grün.\n${BLOCK}`);
  assert.equal(report?.summary, '3 Tests ergänzt');
  assert.deepEqual(report?.areas[0], {
    area: 'Frontend',
    unit: 100,
    component: 36,
    integration: 0,
    e2e: 2,
    passed: 138,
    failed: 0,
    lines: 81.4,
    statements: 80.9,
    branches: 62,
    functions: 74.5,
  });
  assert.equal(report?.areas[1]?.integration, 19);
  assert.equal(report?.areas[1]?.lines, null);
  assert.equal(stripCoverage(`Alle Tests grün.\n${BLOCK}`), 'Alle Tests grün.');
});

test('ignores missing or broken coverage blocks', () => {
  assert.equal(parseCoverage('Keine Messung.'), null);
  assert.equal(parseCoverage('@@COVERAGE {kaputt}'), null);
  assert.equal(parseCoverage('@@COVERAGE {"areas":[]}'), null);
});

test('the last coverage block wins over an interim measurement', () => {
  const first = '@@COVERAGE {"summary":"vorher","areas":[{"area":"Backend","lines":40}]}';
  const last = '@@COVERAGE {"summary":"nachher","areas":[{"area":"Backend","lines":80}]}';
  const report = parseCoverage(`${first}\nTests ergänzt.\n${last}`);
  assert.equal(report?.summary, 'nachher');
  assert.equal(report?.areas[0]?.lines, 80);
  assert.equal(stripCoverage(`${first}\nTests ergänzt.\n${last}`), '\nTests ergänzt.');
});

test('saveCoverage: in einer Transaktion, doppelt gemeldete Bereiche nur einmal', async () => {
  const statements: { sql: string; values: unknown[] }[] = [];
  let released = false;
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      statements.push({ sql, values });
      return { rows: sql.includes('RETURNING id') ? [{ id: 'r-1' }] : [] };
    },
    release: () => (released = true),
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const area = { unit: 1, component: 0, integration: 0, e2e: 0, passed: 1, failed: 0 };
  const values = { lines: null, statements: null, branches: null, functions: null };
  await saveCoverage(pool, 'shop', null, {
    summary: 'x',
    areas: [
      { area: 'Backend', ...area, ...values },
      { area: 'backend', ...area, ...values },
      { area: 'Frontend', ...area, ...values },
    ],
  });
  const areas = statements.filter((entry) => entry.sql.includes('test_coverage_areas')).map((entry) => entry.values[1]);
  assert.deepEqual(areas, ['Backend', 'Frontend']);
  assert.equal(statements[0]?.sql, 'BEGIN');
  assert.equal(statements.at(-1)?.sql, 'COMMIT');
  assert.equal(released, true);
});

test('saveCoverage: Fehler rollt den halben Bericht zurück', async () => {
  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes('test_coverage_areas')) throw new Error('kaputt');
      return { rows: [{ id: 'r-1' }] };
    },
    release: () => undefined,
  };
  const pool = { connect: async () => client } as unknown as Pool;
  await assert.rejects(
    saveCoverage(pool, 'shop', null, {
      summary: 'x',
      areas: [
        {
          area: 'Backend',
          unit: 1,
          component: 0,
          integration: 0,
          e2e: 0,
          passed: 1,
          failed: 0,
          lines: null,
          statements: null,
          branches: null,
          functions: null,
        },
      ],
    }),
    /kaputt/,
  );
  assert.equal(statements.at(-1), 'ROLLBACK');
});
