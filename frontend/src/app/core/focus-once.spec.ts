import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FocusOnce, sameIds } from './focus-once.js';

test('Link-Ziel: nur einmal hinscrollen, nicht bei jedem Nachladen', () => {
  const focus = new FocusOnce();
  assert.equal(focus.take('a', false), false, 'Ziel noch nicht geladen');
  assert.equal(focus.take('a', true), true, 'Ziel erscheint: einmal behandeln');
  assert.equal(focus.take('a', true), false, 'Hintergrund-Poll: nicht erneut');
  assert.equal(focus.take('a', true), false);
  assert.equal(focus.take('b', true), true, 'neues Ziel');
  assert.equal(focus.take(null, false), false);
  assert.equal(focus.take('b', true), true, 'nach dem Löschen wirkt derselbe Link wieder');
});

test('Gleiche ID-Mengen gelten als unverändert', () => {
  assert.ok(sameIds(new Set(['a', 'b']), new Set(['b', 'a'])));
  assert.equal(sameIds(new Set(['a']), new Set(['a', 'b'])), false);
  assert.equal(sameIds(new Set(['a', 'c']), new Set(['a', 'b'])), false);
});
