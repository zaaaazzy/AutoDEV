import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupState, pickInOrder, toggleGroup, toggleId } from './pool-selection.js';

test('Auswahl: einzeln an- und abwählen', () => {
  const one = toggleId(new Set(), 'a');
  assert.deepEqual([...one], ['a']);
  assert.deepEqual([...toggleId(one, 'a')], []);
});

test('Auswahl: Gruppe wählt alle, sind schon alle gewählt, werden sie abgewählt', () => {
  const some = new Set(['a', 'x']);
  const all = toggleGroup(some, ['a', 'b']);
  assert.deepEqual([...all].sort(), ['a', 'b', 'x']);
  assert.deepEqual([...toggleGroup(all, ['a', 'b'])], ['x']);
  assert.deepEqual([...toggleGroup(new Set(), [])], []);
});

test('Auswahl: Zustand der Gruppen-Checkbox', () => {
  assert.equal(groupState(new Set(), ['a', 'b']), 'none');
  assert.equal(groupState(new Set(['a']), ['a', 'b']), 'some');
  assert.equal(groupState(new Set(['a', 'b']), ['a', 'b']), 'all');
  assert.equal(groupState(new Set(['a']), []), 'none');
});

test('Auswahl: in Anzeige-Reihenfolge, nicht mehr verfügbare fallen weg', () => {
  const items = [{ id: 'c' }, { id: 'a' }, { id: 'b' }];
  assert.deepEqual(
    pickInOrder(items, new Set(['b', 'c', 'weg'])).map((item) => item.id),
    ['c', 'b'],
  );
});
