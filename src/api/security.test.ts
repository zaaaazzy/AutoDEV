import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FailureLimiter } from './security.js';

test('FailureLimiter blockt nach zu vielen Fehlversuchen und gibt nach dem Zeitfenster frei', () => {
  const limiter = new FailureLimiter();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    limiter.recordFailure('a', 0);
  }
  assert.equal(limiter.isBlocked('a', 1000), true);
  assert.equal(limiter.isBlocked('b', 1000), false);
  assert.equal(limiter.isBlocked('a', 16 * 60 * 1000), false);
});

test('FailureLimiter.reset hebt die Sperre auf', () => {
  const limiter = new FailureLimiter();
  limiter.recordFailure('a');
  limiter.reset('a');
  assert.equal(limiter.isBlocked('a'), false);
});
