import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReview } from './review.js';

test('reads the reviewer verdict from its marker line', () => {
  assert.equal(parseReview('Sauber umgesetzt.\n@@REVIEW: FREIGEGEBEN'), true);
  assert.equal(parseReview('@@REVIEW: ÄNDERUNGEN NÖTIG\n- Fehlerbehandlung fehlt'), false);
  assert.equal(parseReview('@@REVIEW: AENDERUNGEN NOETIG'), false);
  assert.equal(parseReview('Kein Urteil abgegeben.'), null);
});
