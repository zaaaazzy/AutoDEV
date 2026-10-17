import assert from 'node:assert/strict';
import test from 'node:test';
import { Mutex } from './mutex.js';

test('Mutex lets only one holder run at a time, in arrival order', async () => {
  const mutex = new Mutex();
  const log: string[] = [];
  const work = async (name: string, ms: number): Promise<void> => {
    const release = await mutex.acquire();
    log.push(`${name}:start`);
    await new Promise((resolve) => setTimeout(resolve, ms));
    log.push(`${name}:end`);
    release();
  };
  await Promise.all([work('a', 20), work('b', 5), work('c', 1)]);
  assert.deepEqual(log, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
});
