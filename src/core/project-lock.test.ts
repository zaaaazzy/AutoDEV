import assert from 'node:assert/strict';
import test from 'node:test';
import { withProjectLock } from './project-lock.js';

test('commands in the same project folder run one after another', async () => {
  const log: string[] = [];
  const task = (name: string, ms: number) =>
    withProjectLock('/p', async () => {
      log.push(`start ${name}`);
      await new Promise((done) => setTimeout(done, ms));
      log.push(`end ${name}`);
    });
  await Promise.all([
    task('a', 30),
    task('b', 1),
    withProjectLock('/other', async () => {
      log.push('other');
    }),
  ]);
  assert.deepEqual(
    log.filter((entry) => entry !== 'other'),
    ['start a', 'end a', 'start b', 'end b'],
  );
  await assert.rejects(
    withProjectLock('/p', async () => {
      throw new Error('x');
    }),
  );
  assert.equal(await withProjectLock('/p', async () => 'ok'), 'ok');
});
