import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectionState, toggleAll } from './selection.js';

test('Kopf-Häkchen: keine, einige oder alle sichtbaren Zeilen gewählt', () => {
  assert.equal(selectionState(['a', 'b'], new Set()), 'none');
  assert.equal(selectionState(['a', 'b'], new Set(['a'])), 'some');
  assert.equal(selectionState(['a', 'b'], new Set(['a', 'b', 'x'])), 'all');
  assert.equal(selectionState([], new Set(['x'])), 'none');
});

test('Alle auswählen ergänzt die sichtbaren, alle abwählen entfernt nur die sichtbaren', () => {
  assert.deepEqual([...toggleAll(['a', 'b'], new Set(['x']))].sort(), ['a', 'b', 'x']);
  assert.deepEqual([...toggleAll(['a', 'b'], new Set(['a']))].sort(), ['a', 'b']);
  assert.deepEqual([...toggleAll(['a', 'b'], new Set(['a', 'b', 'x']))], ['x']);
});
