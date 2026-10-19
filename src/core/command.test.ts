import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from './command.js';

test('runCommand names a missing working directory instead of blaming the PATH', async () => {
  const missing = join(tmpdir(), `dev-log-missing-${process.pid}-${Date.now()}`);
  const result = await runCommand(['git', 'status'], missing);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /Arbeitsordner nicht erreichbar/);
  assert.doesNotMatch(result.output, /im PATH des Workers nicht gefunden/);
});

test('runCommand still points to the PATH when the command itself is missing', async () => {
  const result = await runCommand(['dev-log-gibt-es-nicht'], tmpdir());
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /im PATH des Workers nicht gefunden/);
});
