import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkSignal } from './work-signal.js';

test('a wake call ends the wait immediately; without it the full interval elapses', async () => {
  const signal = new WorkSignal();
  const started = Date.now();
  setTimeout(() => signal.wake(), 20);
  await signal.wait(5_000, () => false, 1_000);
  assert.ok(Date.now() - started < 1_000);

  const idle = Date.now();
  await signal.wait(60, () => false, 20);
  assert.ok(Date.now() - idle >= 55);
});

test('a wake before waiting is not lost', async () => {
  const signal = new WorkSignal();
  signal.wake();
  const started = Date.now();
  await signal.wait(5_000, () => false);
  assert.ok(Date.now() - started < 100);
});
