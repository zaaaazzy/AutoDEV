import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveProjectScope } from './runner-cli.js';

test('Projektbereich: Umgebung vor .env vor Elternordner der Installation', () => {
  const install = mkdtempSync(join(tmpdir(), 'devlog-scope-'));
  assert.equal(resolveProjectScope({}, install), tmpdir().replace(/\/$/, ''));
  writeFileSync(join(install, '.env'), 'FOO=1\nDEV_LOG_PROJECT_ROOTS="/Volumes/Daten"\n');
  assert.equal(resolveProjectScope({}, install), '/Volumes/Daten');
  assert.equal(resolveProjectScope({ DEV_LOG_PROJECT_ROOTS: '/srv/projekte' }, install), '/srv/projekte');
});
