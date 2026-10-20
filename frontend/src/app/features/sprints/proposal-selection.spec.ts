import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proposalSelection } from './proposal-selection.js';

const items = [
  { id: 'a', selected: true },
  { id: 'b', selected: false },
];

test('erstes Laden übernimmt die Vorgabe des Servers', () => {
  assert.deepEqual([...proposalSelection(null, 'demo', items)], ['a']);
});

test('gleiches Projekt und gleiche Aufträge behalten die eigene Auswahl', () => {
  const picked = new Set(['b']);
  assert.equal(proposalSelection({ slug: 'demo', ids: ['a', 'b'], picked }, 'demo', items), picked);
});

test('Projektwechsel oder geänderte Aufträge setzen die Vorgabe', () => {
  const picked = new Set(['b']);
  assert.deepEqual([...proposalSelection({ slug: 'other', ids: ['a', 'b'], picked }, 'demo', items)], ['a']);
  assert.deepEqual([...proposalSelection({ slug: 'demo', ids: ['a'], picked }, 'demo', items)], ['a']);
});
