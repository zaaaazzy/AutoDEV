import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { encryptSecret } from '../core/secrets.js';
import { checkSecretKey, secretKeyProblem } from './secret-key-check.js';

const KEY = 'restore-schluessel-0123456789';
const OTHER = 'anderer-schluessel-9876543210';

function poolWith(rows: { place: string; value: string }[]): Pool {
  return { query: async () => ({ rows }) } as unknown as Pool;
}

const sealed = (value: string) => encryptSecret(value, { DEV_LOG_SECRET_KEY: KEY });

const backupRows = () => [
  { place: 'projects.database_url', value: sealed('postgresql://shop:geheim@db/shop') },
  { place: 'users.totp_secret', value: sealed('JBSWY3DPEHPK3PXP') },
  { place: 'projects.database_url', value: 'postgresql://alt:klartext@db/alt' },
];

test('Schlüssel-Test: richtiger Schlüssel liest alle verschlüsselten Werte, Klartext zählt nicht mit', async () => {
  const result = await checkSecretKey(poolWith(backupRows()), { DEV_LOG_SECRET_KEY: KEY });
  assert.deepEqual(result, { encrypted: 2, unreadable: {} });
  assert.equal(secretKeyProblem(result, { DEV_LOG_SECRET_KEY: KEY }), null);
});

test('Schlüssel-Test: falscher Schlüssel meldet Stellen und Anzahl, nie Schlüssel oder Klartext', async () => {
  const env = { DEV_LOG_SECRET_KEY: OTHER };
  const result = await checkSecretKey(poolWith(backupRows()), env);
  assert.deepEqual(result.unreadable, { 'projects.database_url': 1, 'users.totp_secret': 1 });
  const problem = secretKeyProblem(result, env)!;
  assert.match(problem, /2 von 2 verschlüsselten Werten nicht lesbar/);
  assert.match(problem, /passt nicht zu diesem Backup/);
  for (const secret of [OTHER, KEY, 'geheim', 'JBSWY3DPEHPK3PXP']) assert.ok(!problem.includes(secret), secret);
});

test('Schlüssel-Test: ohne Schlüssel sind verschlüsselte Werte nicht lesbar, ohne verschlüsselte Werte ok', async () => {
  const missing = await checkSecretKey(poolWith(backupRows()), {});
  assert.match(secretKeyProblem(missing, {})!, /DEV_LOG_SECRET_KEY ist nicht gesetzt/);
  const plainRows = [{ place: 'projects.database_url', value: 'postgresql://x@db/x' }];
  assert.equal(secretKeyProblem(await checkSecretKey(poolWith(plainRows), {}), {}), null);
});
