import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCommand } from './command.js';

test('runCommand: fehlender Befehl liefert Hinweis auf PATH des Workers', async () => {
  const result = await runCommand(['devlog-nicht-vorhanden-cli', '--version'], process.cwd(), {
    env: { PATH: '/nonexistent-bin' },
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /ENOENT/);
  assert.match(result.output, /„devlog-nicht-vorhanden-cli“ wurde im PATH des Workers nicht gefunden/);
  assert.match(result.output, /install-worker\.sh/);
});

test('runCommand: fehlender Arbeitsordner wird nicht als PATH-Problem gemeldet', async () => {
  const result = await runCommand(['node', '--version'], '/nonexistent-dir-devlog');
  assert.notEqual(result.exitCode, 0);
  assert.doesNotMatch(result.output, /im PATH des Workers nicht gefunden/);
});

test('runCommand: erfolgreicher Befehl', async () => {
  const result = await runCommand([process.execPath, '-e', 'console.log("ok")'], process.cwd());
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /ok/);
});
