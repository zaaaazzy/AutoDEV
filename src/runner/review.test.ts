import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReview } from './review.js';

test('reads the reviewer verdict from its marker line', () => {
  assert.equal(parseReview('Sauber umgesetzt.\n@@REVIEW: FREIGEGEBEN'), true);
  assert.equal(parseReview('@@REVIEW: ÄNDERUNGEN NÖTIG\n- Fehlerbehandlung fehlt'), false);
  assert.equal(parseReview('@@REVIEW: AENDERUNGEN NOETIG'), false);
  assert.equal(parseReview('Kein Urteil abgegeben.'), null);
});

test('an interim approval does not override a later rejection', () => {
  assert.equal(parseReview('@@REVIEW: FREIGEGEBEN\nDoch noch ein Fund.\n@@REVIEW: ÄNDERUNGEN NÖTIG'), false);
  assert.equal(parseReview('@@REVIEW: ÄNDERUNGEN NÖTIG\nBehoben?\n@@REVIEW: FREIGEGEBEN'), false);
  assert.equal(parseReview('@@REVIEW: FREIGEGEBEN\nZusammenfassung.\n@@REVIEW: FREIGEGEBEN'), true);
});
