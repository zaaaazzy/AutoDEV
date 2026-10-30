import assert from 'node:assert/strict';
import test from 'node:test';
import { MIGRATIONS } from '../db/migrations.js';
import { COVERAGE_AREA_KEYS, COVERAGE_AREA_LABELS, coverageAreaKey, isCompleteCoverage } from './coverage-areas.js';

test('Bereichsschlüssel: Bezeichnungen werden per Ganzwort zugeordnet, „gesamt“ hat Vorrang', () => {
  const cases: [string, string | null][] = [
    ['Backend (Express)', 'backend'],
    ['backend', 'backend'],
    ['@shop/api', 'backend'],
    ['API-Server', 'backend'],
    ['Frontend', 'frontend'],
    ['shop-ui', 'frontend'],
    ['Contracts/Shared', 'contracts'],
    ['@mainty/contracts', 'contracts'],
    ['Scripts', 'scripts'],
    ['Skripte', 'scripts'],
    ['E2E (Playwright)', 'e2e'],
    ['e2e', 'e2e'],
    ['gesamt', 'gesamt'],
    ['Gesamt (alle Bereiche)', 'gesamt'],
    ['Backend und Frontend (zusammen)', 'gesamt'],
    ['Insgesamt', 'gesamt'],
    ['Backend + Frontend', 'gesamt'],
    ['Projekt', null],
    ['dev-log', null],
    ['builder', null],
    ['rapid', null],
    ['Gesamtprojekt', null],
  ];
  for (const [label, key] of cases) assert.equal(coverageAreaKey(label), key, label);
  // Schlüssel bilden auf sich selbst ab (gespeicherte Werte bleiben stabil).
  for (const key of COVERAGE_AREA_KEYS) assert.equal(coverageAreaKey(key), key);
  assert.deepEqual(Object.keys(COVERAGE_AREA_LABELS), [...COVERAGE_AREA_KEYS]);
});

test('Vollständiger Lauf: Zeilen, Verzweigungen und Funktionen gesetzt', () => {
  assert.equal(isCompleteCoverage({ lines: 80, branches: 0, functions: 70 }), true);
  assert.equal(isCompleteCoverage({ lines: 80, branches: null, functions: 70 }), false);
  assert.equal(isCompleteCoverage({ lines: null, branches: 60, functions: 70 }), false);
  assert.equal(isCompleteCoverage({ lines: 80, branches: 60, functions: null }), false);
});

test('Migration 19: CHECK auf test_coverage_areas.area enthält genau die Schlüssel aus dem Code', () => {
  const sql = MIGRATIONS.find((step) => step.name === 'testabdeckung-feste-bereiche')?.sql ?? '';
  const check = /CHECK \(area IN \(([^)]*)\)\)/.exec(sql)?.[1];
  assert.ok(check, 'CHECK-Constraint vorhanden');
  assert.deepEqual(
    check.split(',').map((entry) => entry.trim().replace(/^'|'$/g, '')),
    [...COVERAGE_AREA_KEYS],
  );
  // Die Zuordnung in SQL kennt jeden Schlüssel als Ergebnis.
  for (const key of COVERAGE_AREA_KEYS) assert.ok(sql.includes(`THEN '${key}'`), key);
});
