import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEV_API_PORT, devEnvironmentProblem } from './dev-environment.js';

test('Dev-Umgebung: eigener Port und eigene Datenbank sind erlaubt', () => {
  assert.equal(
    devEnvironmentProblem({
      PORT: String(DEV_API_PORT),
      DEV_LOG_DATABASE_URL: 'postgresql://devlog:x@127.0.0.1:5433/aideation_dev',
    }),
    null,
  );
});

test('Dev-Umgebung: Ports des Live-Stacks werden abgewiesen', () => {
  for (const port of ['3100', '5433', '80', '443']) {
    assert.match(devEnvironmentProblem({ PORT: port }) ?? '', /Live-Stack/);
  }
});

test('Dev-Umgebung: Live-Datenbank aideation wird abgewiesen', () => {
  assert.match(
    devEnvironmentProblem({
      PORT: String(DEV_API_PORT),
      DEV_LOG_DATABASE_URL: 'postgresql://devlog:x@127.0.0.1:5433/aideation',
    }) ?? '',
    /Live-Datenbank/,
  );
});
