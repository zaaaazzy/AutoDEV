import assert from 'node:assert/strict';
import test from 'node:test';
import { MASK, maskSecrets, SECRET_PATTERNS } from './secret-mask.js';

test('maskiert Tokens, Passwörter, E-Mail-Adressen und IP-Adressen', () => {
  const text = [
    'login failed for anna.muster@example.ch from 192.168.1.23 and 2001:db8::7334',
    'password=hunter2-secret "apiKey": "abc123def456" token: xyz.987',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'postgresql://devlog:geheim@db:5432/app',
    `key ghp_${'a'.repeat(36)} and sk-ant-${'b'.repeat(24)}`,
  ].join('\n');
  const masked = maskSecrets(text);
  for (const secret of [
    'anna.muster@example.ch',
    '192.168.1.23',
    '2001:db8::7334',
    'hunter2-secret',
    'abc123def456',
    'xyz.987',
    'eyJhbGciOiJIUzI1NiJ9',
    'geheim',
    `ghp_${'a'.repeat(36)}`,
    'sk-ant-',
  ]) {
    assert.ok(!masked.includes(secret), `${secret} bleibt nicht stehen: ${masked}`);
  }
  assert.ok(masked.includes(MASK));
  assert.match(masked, /^login failed for \[MASKIERT\] from \[MASKIERT\]/);
});

test('lässt Uhrzeiten, Pfade und normale Meldungen stehen', () => {
  const text = 'TypeError: Cannot read properties of undefined at 10:30:45 in /app/src/server.js:12:5';
  assert.equal(maskSecrets(text), text);
});

test('Maskierung und Secret-Scan des Git-Syncs nutzen dieselben Muster', () => {
  const key = `AKIA${'A'.repeat(16)}`;
  assert.ok(SECRET_PATTERNS.some((pattern) => pattern.test(key)));
  assert.equal(maskSecrets(`aws ${key}`), `aws ${MASK}`);
});
