import assert from 'node:assert/strict';
import test from 'node:test';
import {
  refuseDefaultDatabasePassword,
  usesDefaultDatabasePassword,
  warnDefaultDatabasePassword,
} from './default-credentials.js';

test('Standardpasswort der Datenbank wird erkannt und ohne URL gemeldet', () => {
  const url = 'postgresql://devlog:devlog_local_dev@db:5432/aideation';
  assert.equal(usesDefaultDatabasePassword(url), true);
  assert.equal(usesDefaultDatabasePassword('postgresql://devlog:geheim@db:5432/aideation'), false);
  assert.equal(usesDefaultDatabasePassword('keine url'), false);

  const warnings: string[] = [];
  warnDefaultDatabasePassword(url, (message) => warnings.push(message));
  warnDefaultDatabasePassword('postgresql://devlog:geheim@db:5432/aideation', (message) => warnings.push(message));
  assert.equal(warnings.length, 1);
  const [warning = ''] = warnings;
  assert.match(warning, /Standardpasswort/);
  assert.ok(!warning.includes('@db:5432'));
});

test('Standardpasswort der Datenbank bricht den Start ab, ausser mit ausdrücklicher Freigabe', () => {
  const url = 'postgresql://devlog:devlog_local_dev@db:5432/aideation';
  assert.throws(
    () => refuseDefaultDatabasePassword(url, {}),
    (error: Error) => {
      assert.match(error.message, /Start abgebrochen/);
      assert.ok(!error.message.includes('@db:5432'));
      return true;
    },
  );
  assert.doesNotThrow(() => refuseDefaultDatabasePassword('postgresql://devlog:geheim@db:5432/aideation', {}));
  const warnings: string[] = [];
  refuseDefaultDatabasePassword(url, { DEV_LOG_ALLOW_DEFAULT_DB_PASSWORD: '1' }, (message) => warnings.push(message));
  assert.equal(warnings.length, 1);
});
