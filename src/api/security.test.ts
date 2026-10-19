import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { createDevLogApp } from './app.js';
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

async function postBehindProxy(trustProxy: string | undefined): Promise<number> {
  const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
  const server = createDevLogApp(pool, null, { trustProxy }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: `https://127.0.0.1:${port}`,
        'x-forwarded-proto': 'https',
      },
      body: '{}',
    });
    return response.status;
  } finally {
    server.close();
  }
}

test('hinter dem TLS-Proxy gelten https-Anfragen nur mit trustProxy als gleiche Herkunft', async () => {
  assert.equal(await postBehindProxy(undefined), 403);
  assert.notEqual(await postBehindProxy('loopback'), 403);
});
