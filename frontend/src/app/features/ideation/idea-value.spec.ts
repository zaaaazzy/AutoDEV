import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesSelection } from '../../shared/data-table/filter.js';
import {
  CREATED_SORT,
  ideaValue,
  ideaValueText,
  openIdeasSort,
  SCORE_FILTER_OPTIONS,
  VALUE_SORT,
} from './idea-options.js';

test('Wert = Nutzen / Kosten mit einer Nachkommastelle und Komma', () => {
  assert.equal(ideaValueText({ benefit: 8, cost: 3 }), '2,7');
  assert.equal(ideaValueText({ benefit: 10, cost: 1 }), '10,0');
  assert.equal(ideaValueText({ benefit: 0, cost: 4 }), '0,0');
  assert.ok(Math.abs(ideaValue({ benefit: 8, cost: 3 })! - 8 / 3) < 1e-9);
});

test('Wert bleibt leer ohne Nutzen, ohne Kosten oder bei Kosten 0', () => {
  for (const idea of [{ benefit: 8, cost: 0 }, { benefit: 8, cost: null }, { benefit: null, cost: 3 }, {}]) {
    assert.equal(ideaValue(idea), null);
    assert.equal(ideaValueText(idea), '');
  }
});

test('Filter Nutzen/Kosten: Werte 0–10, Zahlen passen auf die gewählten Werte', () => {
  assert.deepEqual(SCORE_FILTER_OPTIONS, ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
  assert.equal(matchesSelection(8, ['8']), true);
  assert.equal(matchesSelection(3, ['8']), false);
  assert.equal(matchesSelection(null, ['0']), false);
});

test('Standard-Sortierung: Wert absteigend nur mit Visionär-Idee, sonst Erstellt absteigend', () => {
  assert.equal(openIdeasSort([{ source: 'human' }, { source: 'visionary' }]), VALUE_SORT);
  assert.equal(openIdeasSort([{ source: 'human' }, {}]), CREATED_SORT);
  assert.equal(openIdeasSort([]), CREATED_SORT);
  assert.deepEqual(VALUE_SORT, [{ id: 'value', desc: true }]);
  assert.deepEqual(CREATED_SORT, [{ id: 'createdAt', desc: true }]);
});
