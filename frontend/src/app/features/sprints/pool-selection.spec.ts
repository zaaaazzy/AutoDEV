import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickInOrder } from './pool-selection.js';

test('Auswahl: in Anzeige-Reihenfolge, nicht mehr verfügbare fallen weg', () => {
  const items = [{ id: 'c' }, { id: 'a' }, { id: 'b' }];
  assert.deepEqual(
    pickInOrder(items, new Set(['b', 'c', 'weg'])).map((item) => item.id),
    ['c', 'b'],
  );
});
