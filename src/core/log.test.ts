import assert from 'node:assert/strict';
import test from 'node:test';
import { clearLogged, logged } from './log.js';

test('logged returns the fallback and logs each message once per key', (t) => {
  const errors = t.mock.method(console, 'error', () => undefined);
  const handler = logged('test-key', [] as string[]);
  assert.deepEqual(handler(new Error('weg')), []);
  handler(new Error('weg'));
  assert.equal(errors.mock.callCount(), 1);
  assert.match(String(errors.mock.calls[0]?.arguments[0]), /\[test-key\] weg/);
  clearLogged('test-key');
  handler(new Error('weg'));
  assert.equal(errors.mock.callCount(), 2);
});
