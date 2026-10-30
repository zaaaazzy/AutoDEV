import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { COVERAGE_AREA_KEYS } from '../core/coverage-areas.js';
import { COVERAGE_INSTRUCTIONS, parseCoverage, saveCoverage, selectCoverage, stripCoverage } from './coverage.js';

const BLOCK =
  '@@COVERAGE {"summary":"3 Tests ergänzt","areas":[{"area":"Frontend","unit":100,"component":36,"integration":0,"e2e":2,"passed":138,"failed":0,"lines":81.4,"statements":80.9,"branches":62,"functions":"74.5"},{"area":"Backend","unit":50,"integration":19,"lines":null}]}';

test('parses the tester coverage block per area', () => {
  const report = parseCoverage(`Alle Tests grün.\n${BLOCK}`);
  assert.equal(report?.summary, '3 Tests ergänzt');
  assert.deepEqual(report?.areas[0], {
    area: 'frontend',
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

test('parseCoverage: Bezeichnungen werden Schlüsseln zugeordnet, unbekannte mit Grund verworfen', () => {
  const block = (areas: object[]) => `@@COVERAGE ${JSON.stringify({ summary: 's', areas })}`;
  const report = parseCoverage(
    block([
      { area: 'Backend (Express)', lines: 80, branches: 70, functions: 90 },
      { area: 'Backend und Frontend (zusammen)', lines: 75, branches: 60, functions: 85 },
      { area: 'Contracts/Shared', lines: 90, branches: 80, functions: 95 },
      { area: 'Projekt', lines: 50, branches: 40, functions: 60 },
    ]),
  );
  assert.deepEqual(
    report?.areas.map((area) => area.area),
    ['backend', 'gesamt', 'contracts'],
  );
  assert.equal(report?.discarded?.length, 1);
  assert.match(report!.discarded![0]!, /„Projekt“ verworfen: keinem Bereich zuordenbar/);
  // Nur unbekannte Bezeichnungen: Bericht ohne Bereiche, aber mit Grund (statt still nichts).
  const unknown = parseCoverage(block([{ area: 'Sonstiges', lines: 1, branches: 1, functions: 1 }]));
  assert.deepEqual(unknown?.areas, []);
  assert.equal(unknown?.discarded?.length, 1);
});

test('der Tester-Prompt nennt als Beispiele nur die festen Schlüssel', () => {
  for (const key of COVERAGE_AREA_KEYS) assert.ok(COVERAGE_INSTRUCTIONS.includes(key), key);
  assert.doesNotMatch(COVERAGE_INSTRUCTIONS, /Contracts\/Shared|"area":"Frontend"|z\. B\. Frontend/);
  assert.match(COVERAGE_INSTRUCTIONS, /"area":"frontend"/);
});

const counts = { unit: 1, component: 0, integration: 0, e2e: 0, passed: 1, failed: 0, statements: null };
const full = { lines: 80, branches: 70, functions: 90 };

test('selectCoverage: nur vollständige Läufe mit festem Schlüssel, je Schlüssel einmal', () => {
  const { areas, discarded } = selectCoverage({
    summary: 'x',
    discarded: ['„Projekt“ verworfen: keinem Bereich zuordenbar'],
    areas: [
      { area: 'backend', ...counts, lines: 80, branches: null, functions: 90 },
      { area: 'backend', ...counts, ...full },
      { area: 'Backend', ...counts, ...full, lines: 10 },
      { area: 'frontend', ...counts, lines: null, branches: null, functions: null },
      { area: 'dev-log', ...counts, ...full },
    ],
  });
  assert.deepEqual(
    areas.map((area) => [area.area, area.lines]),
    [['backend', 80]],
  );
  assert.deepEqual(discarded, [
    '„Projekt“ verworfen: keinem Bereich zuordenbar',
    'backend verworfen: ohne Prozentwerte (fehlt: Verzweigungen)',
    'backend verworfen: doppelt gemeldet',
    'frontend verworfen: ohne Prozentwerte (fehlt: Zeilen, Verzweigungen, Funktionen)',
    `„dev-log“ verworfen: keinem Bereich zuordenbar (erlaubt: ${COVERAGE_AREA_KEYS.join(', ')})`,
  ]);
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
  const result = await saveCoverage(pool, 'shop', null, {
    summary: 'x',
    areas: [
      { area: 'backend', ...counts, ...full },
      { area: 'backend', ...counts, ...full },
      { area: 'frontend', ...counts, ...full },
    ],
  });
  const areas = statements.filter((entry) => entry.sql.includes('test_coverage_areas')).map((entry) => entry.values[1]);
  assert.deepEqual(areas, ['backend', 'frontend']);
  assert.deepEqual(result, { saved: ['backend', 'frontend'], discarded: ['backend verworfen: doppelt gemeldet'] });
  assert.equal(statements[0]?.sql, 'BEGIN');
  assert.equal(statements.at(-1)?.sql, 'COMMIT');
  assert.equal(released, true);
});

test('saveCoverage: ohne vollständigen Bereich wird kein Bericht angelegt', async () => {
  let connected = false;
  const pool = {
    connect: async () => {
      connected = true;
      throw new Error('keine Verbindung erwartet');
    },
  } as unknown as Pool;
  const result = await saveCoverage(pool, 'shop', null, {
    summary: 'x',
    areas: [{ area: 'backend', ...counts, lines: null, branches: null, functions: null }],
  });
  assert.equal(connected, false);
  assert.deepEqual(result.saved, []);
  assert.equal(result.discarded.length, 1);
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
          area: 'backend',
          unit: 1,
          component: 0,
          integration: 0,
          e2e: 0,
          passed: 1,
          failed: 0,
          lines: 80,
          statements: null,
          branches: 70,
          functions: 90,
        },
      ],
    }),
    /kaputt/,
  );
  assert.equal(statements.at(-1), 'ROLLBACK');
});
