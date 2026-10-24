import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { nodeVersionOk, packageSpecs, prepareGameTools, type ToolRunner } from './game-tools.js';

const ROOT = join(import.meta.dirname, '..', '..');

test('Node-Version: ab 22.12 (Vite 8 der Phaser-Vorlage, Angular 20)', () => {
  for (const version of ['22.12.0', 'v22.22.3', '23.0.0', '24.1.0'])
    assert.equal(nodeVersionOk(version), true, version);
  for (const version of ['22.11.9', '21.7.3', '20.19.0', '']) assert.equal(nodeVersionOk(version), false, version);
});

test('Paket-Angaben der Vorlage für den npm-Cache', async () => {
  assert.deepEqual(packageSpecs('{"dependencies":{"phaser":"^3.90.0"},"devDependencies":{"vite":"^8.3.5"}}'), [
    'phaser@^3.90.0',
    'vite@^8.3.5',
  ]);
  const specs = packageSpecs(await readFile(join(ROOT, 'templates', 'phaser-game', 'package.json'), 'utf8'));
  assert.ok(specs.some((spec) => spec.startsWith('phaser@^3.')));
  assert.ok(specs.some((spec) => spec.startsWith('vite@')));
  assert.ok(specs.includes('@playwright/test@1.64.1'));
});

function recorder(ok = true) {
  const calls: string[][] = [];
  const run: ToolRunner = async (command, args) => {
    calls.push([command, ...args]);
    return { ok, output: '' };
  };
  return { calls, run };
}

test('Spiele-Werkzeuge: Chromium nur laden, wenn er fehlt, Pakete der Vorlage vorladen', async () => {
  const lines: string[] = [];
  const missing = recorder();
  const result = await prepareGameTools(missing.run, (line) => lines.push(line), {
    platform: 'darwin',
    check: async () => ({ installed: false }),
  });
  assert.deepEqual(result, { chromium: true, cached: true, notes: [] });
  assert.deepEqual(missing.calls[0], ['npx', '--no-install', 'playwright', 'install', 'chromium']);
  assert.deepEqual(missing.calls[1]?.slice(0, 3), ['npm', 'cache', 'add']);
  assert.ok(missing.calls[1]?.some((arg) => arg.startsWith('phaser@^3.')));
  assert.ok(!lines.some((line) => line.includes('install-deps')), 'Hinweis auf Systembibliotheken nur unter Linux');

  const present = recorder();
  await prepareGameTools(present.run, (line) => lines.push(line), {
    platform: 'linux',
    check: async () => ({ installed: true }),
  });
  assert.deepEqual(
    present.calls.map((call) => call[0]),
    ['npm'],
  );
  assert.ok(lines.some((line) => line.includes('install-deps chromium')));
});

test('Spiele-Werkzeuge: Fehler brechen nicht ab, sondern landen als Hinweis', async () => {
  const failing = recorder(false);
  const result = await prepareGameTools(failing.run, () => undefined, {
    platform: 'win32',
    check: async () => ({ installed: false }),
    templateRoot: join(ROOT, 'gibt-es-nicht'),
  });
  assert.equal(result.chromium, false);
  assert.equal(result.cached, false);
  assert.equal(result.notes.length, 2);
  assert.deepEqual(
    failing.calls.map((call) => call[0]),
    ['npx'],
    'ohne lesbare Vorlage kein npm cache add',
  );
});
