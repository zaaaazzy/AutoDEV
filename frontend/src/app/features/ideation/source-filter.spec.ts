import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterFacets, matchesSelection } from '../../shared/data-table/filter.js';
import { statusLabel } from '../../shared/labels.js';
import { IDEA_SOURCES, SOURCE_FILTER_OPTIONS, sourceLabel } from './idea-options.js';

type Row = { id: string; source: string | null; status: string };

// Je Herkunft eine offene und eine geprüfte Idee, dazu eine ältere ohne Herkunft (gilt als „Mensch“).
const ROWS: Row[] = [
  ...IDEA_SOURCES.flatMap((source) => [
    { id: `${source}-idea`, source, status: 'idea' },
    { id: `${source}-review`, source, status: 'review' },
  ]),
  { id: 'legacy', source: null, status: 'idea' },
];

/** Wie die Tabelle: Herkunft- und Statusfilter auf die angezeigten Werte, beide müssen passen. */
function visible(source: string[], status: string[] = []): string[] {
  return ROWS.filter(
    (row) => matchesSelection(sourceLabel(row.source), source) && matchesSelection(statusLabel(row.status), status),
  ).map((row) => row.id);
}

test('Herkunft-Filter bietet Mensch, Visionär, Routine, Produktion und GitHub an', () => {
  assert.deepEqual(SOURCE_FILTER_OPTIONS, ['Mensch', 'Visionär', 'Routine', 'Produktion', 'GitHub']);
  assert.deepEqual(IDEA_SOURCES, ['human', 'visionary', 'routine', 'production', 'github']);
  // Badge und Filter heißen gleich.
  assert.equal(sourceLabel('visionary'), 'Visionär');
});

test('„Alle“ (keine Auswahl) zeigt alle Ideen unabhängig von der Herkunft', () => {
  assert.deepEqual(
    visible([]),
    ROWS.map((row) => row.id),
  );
});

test('Jeder Herkunftswert zeigt nur Ideen dieser Herkunft', () => {
  for (const source of IDEA_SOURCES) {
    const expected = [`${source}-idea`, `${source}-review`, ...(source === 'human' ? ['legacy'] : [])];
    assert.deepEqual(visible([sourceLabel(source)]), expected, source);
  }
});

test('Herkunft und Status zusammen: nur Ideen, die beide Bedingungen erfüllen', () => {
  assert.deepEqual(visible(['Visionär'], [statusLabel('review')]), ['visionary-review']);
  assert.deepEqual(visible(['Visionär', 'GitHub'], [statusLabel('idea')]), ['visionary-idea', 'github-idea']);
  assert.deepEqual(visible(['Visionär'], [statusLabel('rejected')]), []);
});

test('Filtermenü: feste Optionen in ihrer Reihenfolge, auch ohne Treffer', () => {
  const unique = new Map<unknown, number>([
    ['Visionär', 3],
    ['Mensch', 2],
    ['', 1],
  ]);
  assert.deepEqual(filterFacets(unique, SOURCE_FILTER_OPTIONS), [
    { value: 'Mensch', count: 2 },
    { value: 'Visionär', count: 3 },
    { value: 'Routine', count: 0 },
    { value: 'Produktion', count: 0 },
    { value: 'GitHub', count: 0 },
  ]);
  // Ohne feste Optionen wie bisher: nur vorhandene Werte, alphabetisch.
  assert.deepEqual(filterFacets(unique), [
    { value: 'Mensch', count: 2 },
    { value: 'Visionär', count: 3 },
  ]);
});
