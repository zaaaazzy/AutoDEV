import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptSecret, encryptSecret, isEncrypted } from './secrets.js';

const env = { DEV_LOG_SECRET_KEY: 'ein-langer-geheimer-schluessel' };
const url = 'postgresql://app:geheim@localhost:5432/app';

test('secrets are encrypted with a key and read back', () => {
  const stored = encryptSecret(url, env);
  assert.ok(isEncrypted(stored));
  assert.doesNotMatch(stored, /geheim/);
  assert.notEqual(encryptSecret(url, env), stored, 'every value gets its own IV');
  assert.equal(decryptSecret(stored, env), url);
  assert.equal(encryptSecret(stored, env), stored, 'no double encryption');
});

test('without a key values stay plain, encrypted ones fail loudly', () => {
  assert.equal(encryptSecret(url, {}), url);
  assert.equal(decryptSecret(url, env), url, 'plain values from before still work');
  assert.throws(() => decryptSecret(encryptSecret(url, env), {}), /DEV_LOG_SECRET_KEY/);
  assert.throws(() => decryptSecret(encryptSecret(url, env), { DEV_LOG_SECRET_KEY: 'ein-anderer-schluessel!' }));
});
