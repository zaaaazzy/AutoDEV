import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareSortValues } from './sort.js';

/** Wie TanStack: Vergleich bei absteigender Sortierung umdrehen. */
function sorted(values: (number | null)[], desc: boolean, emptyLast = true): (number | null)[] {
  return [...values].sort((a, b) => compareSortValues(a, b, { desc, emptyLast }) * (desc ? -1 : 1));
}

test('Zahlen numerisch, Texte deutsch mit Zahlen im Text', () => {
  assert.ok(compareSortValues(2, 10) < 0);
  assert.ok(compareSortValues('Idee 2', 'Idee 10') < 0);
  assert.equal(compareSortValues('ärger', 'Ärger'), 0);
});

test('emptyLast: leere Werte stehen in beiden Richtungen hinten', () => {
  const values = [null, 2.7, 0.5, null, 5];
  assert.deepEqual(sorted(values, false), [0.5, 2.7, 5, null, null]);
  assert.deepEqual(sorted(values, true), [5, 2.7, 0.5, null, null]);
});

test('ohne emptyLast bleibt das bisherige Verhalten (leer = kleinster Text)', () => {
  assert.equal(compareSortValues(null, null), 0);
  assert.ok(compareSortValues('', 'a') < 0);
});
