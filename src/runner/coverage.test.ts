import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { COVERAGE_AREA_KEYS } from '../core/coverage-areas.js';
import {
  COVERAGE_INSTRUCTIONS,
  type CoverageArea,
  CoverageValidationError,
  parseCoverage,
  saveCoverage,
  stripCoverage,
  validateCoverage,
} from './coverage.js';

const BLOCK =
  '@@COVERAGE {"summary":"3 Tests ergänzt","areas":[{"area":"frontend","unit":100,"component":36,"integration":0,"e2e":2,"passed":138,"failed":0,"lines":81.4,"statements":80.9,"branches":62,"functions":74.5},{"area":"Backend","unit":50,"integration":19,"lines":70,"branches":55}]}';

test('parses the tester coverage block per area', () => {
  const { report, errors } = parseCoverage(`Alle Tests grün.\n${BLOCK}`);
  assert.deepEqual(errors, []);
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
  assert.equal(report?.areas[1]?.area, 'backend', 'Groß-/Kleinschreibung der festen Namen egal');
  assert.equal(report?.areas[1]?.integration, 19);
  assert.equal(report?.areas[1]?.statements, null, 'statements/functions bleiben optional');
  assert.equal(stripCoverage(`Alle Tests grün.\n${BLOCK}`), 'Alle Tests grün.');
});

test('kein Block: kein Bericht und kein Fehler; kaputter Block: Grund statt Bericht', () => {
  assert.deepEqual(parseCoverage('Keine Messung.'), { report: null, errors: [] });
  assert.deepEqual(parseCoverage('@@COVERAGE {kaputt}'), { report: null, errors: ['Kein gültiges JSON.'] });
  assert.deepEqual(parseCoverage('@@COVERAGE {"areas":[]}'), { report: null, errors: ['Keine Bereiche gemeldet.'] });
});

test('the last coverage block wins over an interim measurement', () => {
  const first = '@@COVERAGE {"summary":"vorher","areas":[{"area":"backend","unit":1,"lines":40,"branches":30}]}';
  const last = '@@COVERAGE {"summary":"nachher","areas":[{"area":"backend","unit":2,"lines":80,"branches":70}]}';
  const { report } = parseCoverage(`${first}\nTests ergänzt.\n${last}`);
  assert.equal(report?.summary, 'nachher');
  assert.equal(report?.areas[0]?.lines, 80);
  assert.equal(stripCoverage(`${first}\nTests ergänzt.\n${last}`), '\nTests ergänzt.');
});

const valid = { area: 'backend', unit: 3, lines: 80, branches: 60 };

test('Validator: unbekannter Bereich wird abgelehnt, nicht angelegt', () => {
  const result = validateCoverage({ areas: [valid, { ...valid, area: 'Sonstiges' }] });
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.errors[0]! : '', /Bereich „Sonstiges“ unbekannt \(erlaubt: backend, frontend/);
  // Auch eine bekannte Schreibweise ist in einer Meldung kein gültiger Name: Gemeldet werden nur die festen Namen.
  assert.equal(validateCoverage({ areas: [{ ...valid, area: 'server' }] }).ok, false);
  assert.equal(validateCoverage({ areas: [{ ...valid, area: 'Backend (Express)' }] }).ok, false);
  for (const area of COVERAGE_AREA_KEYS) assert.equal(validateCoverage({ areas: [{ ...valid, area }] }).ok, true, area);
});

test('Validator: fehlender oder ungültiger Zeilen- oder Zweigwert wird abgelehnt (auch null)', () => {
  for (const broken of [
    { ...valid, lines: null },
    { ...valid, lines: undefined },
    { ...valid, branches: null },
    { ...valid, branches: '60' },
    { ...valid, lines: 101 },
    { ...valid, branches: -1 },
  ]) {
    const result = validateCoverage({ areas: [broken] });
    assert.equal(result.ok, false, JSON.stringify(broken));
    assert.match(!result.ok ? result.errors[0]! : '', /Bereich backend: (Zeilenwert|Zweigwert)/);
  }
  assert.equal(validateCoverage({ areas: [{ ...valid, lines: 0, branches: 100 }] }).ok, true, 'Grenzen 0 und 100');
});

test('Validator: 0 Testfälle in einem Bereich lehnen die ganze Meldung ab', () => {
  const result = validateCoverage({
    areas: [valid, { area: 'frontend', unit: 0, component: 0, passed: 5, lines: 80, branches: 70 }],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(!result.ok && result.errors, ['Bereich frontend: 0 Testfälle.']);
});

test('Validator: doppelte Bereiche, negative Zahlen und Nicht-Objekte werden abgelehnt', () => {
  assert.equal(validateCoverage({ areas: [valid, { ...valid, area: 'Backend' }] }).ok, false);
  assert.equal(validateCoverage({ areas: [{ ...valid, unit: -2 }] }).ok, false);
  assert.equal(validateCoverage({ areas: [{ ...valid, statements: 120 }] }).ok, false);
  assert.equal(validateCoverage(null).ok, false);
  assert.equal(validateCoverage({ areas: ['backend'] }).ok, false);
});

test('Tester-Prompt nennt alle festen Bereiche und verbietet null und Bereiche ohne Tests', () => {
  for (const area of COVERAGE_AREA_KEYS) assert.ok(COVERAGE_INSTRUCTIONS.includes(`\`${area}\``), area);
  for (const area of ['backend', 'frontend', 'scripts', 'e2e', 'gesamt', 'auftrag']) {
    assert.ok(COVERAGE_INSTRUCTIONS.includes(`\`${area}\``), area);
  }
  assert.match(COVERAGE_INSTRUCTIONS, /`null` ist nicht erlaubt/);
  assert.match(COVERAGE_INSTRUCTIONS, /Bereiche ohne Tests .* sind nicht erlaubt/);
  assert.doesNotMatch(COVERAGE_INSTRUCTIONS, /als null/);
  // Als Beispiel nur feste Schlüssel, keine freien Bezeichnungen.
  assert.doesNotMatch(COVERAGE_INSTRUCTIONS, /Contracts\/Shared|"area":"Frontend"|z\. B\. Frontend/);
  assert.match(COVERAGE_INSTRUCTIONS, /"area":"frontend"/);
  // Das Beispiel im Prompt besteht selbst den Validator.
  const example = parseCoverage(COVERAGE_INSTRUCTIONS.split('\n').at(-1)!);
  assert.deepEqual(example.errors, []);
});

const area = (overrides: Partial<CoverageArea> = {}): CoverageArea => ({
  area: 'backend',
  unit: 1,
  component: 0,
  integration: 0,
  e2e: 0,
  passed: 1,
  failed: 0,
  lines: 80,
  statements: null,
  branches: 60,
  functions: null,
  ...overrides,
});

function fakeClient(fail?: RegExp) {
  const statements: { sql: string; values: unknown[] }[] = [];
  let released = false;
  let connected = false;
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      statements.push({ sql, values });
      if (fail?.test(sql)) throw new Error('kaputt');
      return { rows: sql.includes('RETURNING id') ? [{ id: 'r-1' }] : [] };
    },
    release: () => (released = true),
  };
  const pool = {
    connect: async () => {
      connected = true;
      return client;
    },
  } as unknown as Pool;
  return { pool, statements, released: () => released, connected: () => connected };
}

test('saveCoverage: in einer Transaktion mit den festen Namen', async () => {
  const fake = fakeClient();
  assert.equal(
    await saveCoverage(fake.pool, 'shop', null, { summary: 'x', areas: [area(), area({ area: 'frontend' })] }),
    'r-1',
  );
  const areas = fake.statements.filter((entry) => entry.sql.includes('test_coverage_areas')).map((e) => e.values[1]);
  assert.deepEqual(areas, ['backend', 'frontend']);
  assert.equal(fake.statements[0]?.sql, 'BEGIN');
  assert.equal(fake.statements.at(-1)?.sql, 'COMMIT');
  assert.equal(fake.released(), true);
});

test('saveCoverage: ungültiger Bericht wird abgelehnt und nicht gespeichert', async () => {
  for (const broken of [
    [area({ area: 'Sonstiges' as unknown as CoverageArea['area'] })],
    [area({ lines: null as unknown as number })],
    [area({ unit: 0 })],
    [area(), area()],
  ]) {
    const fake = fakeClient();
    await assert.rejects(
      saveCoverage(fake.pool, 'shop', null, { summary: 'x', areas: broken }),
      CoverageValidationError,
    );
    assert.equal(fake.connected(), false, 'keine Verbindung, nichts geschrieben');
  }
});

test('saveCoverage: Fehler rollt den halben Bericht zurück', async () => {
  const fake = fakeClient(/test_coverage_areas/);
  await assert.rejects(saveCoverage(fake.pool, 'shop', null, { summary: 'x', areas: [area()] }), /kaputt/);
  assert.equal(fake.statements.at(-1)?.sql, 'ROLLBACK');
});
