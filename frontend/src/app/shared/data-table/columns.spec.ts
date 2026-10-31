import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATEGORY_FILTER_OPTIONS, categoryColumn } from './columns.js';
import { filterFacets, matchesSelection } from './filter.js';

interface Row {
  id: string;
  category: string | null;
}

const rows: Row[] = [
  { id: 'a', category: 'backend' },
  { id: 'b', category: 'frontend' },
  { id: 'c', category: null },
  { id: 'd', category: 'backend' },
];

test('Kategoriefilter: „Backend“ lässt nur Zeilen dieser Kategorie stehen, „Ohne Kategorie“ die leeren', () => {
  const column = categoryColumn<Row>((row) => row.category, true);
  const visible = (wanted: string[]) =>
    rows.filter((row) => matchesSelection(column.value(row), wanted)).map((row) => row.id);
  assert.deepEqual(visible(['Backend']), ['a', 'd']);
  assert.deepEqual(visible(['Ohne Kategorie']), ['c']);
  assert.deepEqual(visible([]), ['a', 'b', 'c', 'd']);
});

test('Kategoriefilter bietet immer alle Kategorien und „Ohne Kategorie“ an', () => {
  const column = categoryColumn<Row>((row) => row.category, true);
  assert.equal(column.filter, 'select');
  assert.deepEqual(CATEGORY_FILTER_OPTIONS, [
    'Frontend',
    'Backend',
    'Fullstack',
    'Infrastruktur',
    'Dokumentation',
    'Sicherheit',
    'Ohne Kategorie',
  ]);
  const facets = filterFacets(new Map([['Backend', 2]]), column.options);
  assert.deepEqual(
    facets.map((facet) => [facet.value, facet.count]),
    CATEGORY_FILTER_OPTIONS.map((value) => [value, value === 'Backend' ? 2 : 0]),
  );
  // Ohne feste Werte bleibt die Spalte wie in den anderen Tabellen.
  assert.equal(categoryColumn<Row>((row) => row.category).options, undefined);
});
