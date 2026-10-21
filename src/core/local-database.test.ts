import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { adminDatabaseUrl, localDatabaseUrl, readEnvValues } from './local-database.js';

test('Lokale Datenbank: Passwort aus der .env statt Standardpasswort, Sonderzeichen kodiert', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-database-'));
  try {
    assert.equal(
      localDatabaseUrl(readEnvValues(root)),
      'postgresql://devlog:devlog_local_dev@127.0.0.1:5433/aideation',
    );
    await writeFile(join(root, '.env'), "DEV_LOG_DB_USER=anna\nDEV_LOG_DB_PASSWORD='p@ss:w/rd'\n");
    const url = localDatabaseUrl(readEnvValues(root));
    assert.equal(url, 'postgresql://anna:p%40ss%3Aw%2Frd@127.0.0.1:5433/aideation');
    assert.equal(decodeURIComponent(new URL(url).password), 'p@ss:w/rd');
    assert.equal(adminDatabaseUrl(url), 'postgresql://anna:p%40ss%3Aw%2Frd@127.0.0.1:5433/postgres');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
