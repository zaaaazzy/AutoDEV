import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  DEFAULT_TEST_COMMANDS,
  loadTestCommandSet,
  loadTestCommands,
  NO_PACKAGE_NOTE,
  skippedTestCommandsNote,
} from './runner-selection.js';

function poolWith(testCommands: unknown): Pool {
  return {
    query: async (sql: string) => {
      if (sql.includes('test_commands')) return { rows: [{ commands: testCommands }] };
      return { rows: [] };
    },
  } as unknown as Pool;
}

test('Testbefehle mit Herkunft: Projekt vor Umgebung vor Standardwerten', async () => {
  const environment = { DEV_LOG_TEST_COMMANDS: '[["make","check"]]' };
  assert.deepEqual(await loadTestCommandSet(poolWith([['npm', 'run', 'test:unit']]), 'p', environment), {
    commands: [['npm', 'run', 'test:unit']],
    source: 'project',
  });
  assert.deepEqual(await loadTestCommandSet(poolWith(null), 'p', environment), {
    commands: [['make', 'check']],
    source: 'env',
  });
  const defaults = await loadTestCommandSet(poolWith(null), 'p', {});
  assert.equal(defaults.source, 'default');
  assert.deepEqual(defaults.commands, DEFAULT_TEST_COMMANDS);
  // Ungültige Umgebungswerte fallen auf die Standardwerte zurück (wie bisher).
  assert.equal((await loadTestCommandSet(poolWith(null), 'p', { DEV_LOG_TEST_COMMANDS: 'kaputt' })).source, 'default');
  assert.deepEqual(await loadTestCommands(poolWith(null), 'p', {}), DEFAULT_TEST_COMMANDS);
});

test('Standard-Testbefehle entfallen nur ohne package.json; hinterlegte Befehle nie', async () => {
  const docsOnly = await mkdtemp(join(tmpdir(), 'selection-docs-'));
  const node = await mkdtemp(join(tmpdir(), 'selection-node-'));
  await writeFile(join(node, 'package.json'), '{}');
  const defaults = await loadTestCommandSet(poolWith(null), 'p', {});
  assert.equal(skippedTestCommandsNote(defaults, docsOnly), NO_PACKAGE_NOTE);
  assert.equal(skippedTestCommandsNote(defaults, node), null);
  const own = await loadTestCommandSet(poolWith([['npm', 'test']]), 'p', {});
  assert.equal(skippedTestCommandsNote(own, docsOnly), null);
  const env = await loadTestCommandSet(poolWith(null), 'p', { DEV_LOG_TEST_COMMANDS: '[["npm","test"]]' });
  assert.equal(skippedTestCommandsNote(env, docsOnly), null);
});
