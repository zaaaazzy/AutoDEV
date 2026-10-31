import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  collectEdges,
  evaluate,
  findCycles,
  layerOf,
  layerViolations,
  parseImports,
  rebuildBaseline,
  resolveImport,
} from './lib/layers.js';

test('parseImports: statische, dynamische und Re-Export-Importe, Typ-Importe markiert', () => {
  const source = `
import { a } from './a.js';
import type { B } from '../core/b.js';
import { type C, type D } from './c.js';
import { type E, f } from './e.js';
import './side.js';
import express from 'express';
export { g } from './g.js';
export type { H } from './h.js';
export * from './all.js';
const lazy = await import('./lazy.js');
`;
  assert.deepEqual(parseImports(source), [
    { specifier: './a.js', typeOnly: false },
    { specifier: '../core/b.js', typeOnly: true },
    { specifier: './c.js', typeOnly: true },
    { specifier: './e.js', typeOnly: false },
    { specifier: './side.js', typeOnly: false },
    { specifier: './g.js', typeOnly: false },
    { specifier: './h.js', typeOnly: true },
    { specifier: './all.js', typeOnly: false },
    { specifier: './lazy.js', typeOnly: false },
  ]);
});

test('layerOf und resolveImport', () => {
  assert.equal(layerOf('src/core/status.ts'), 'core');
  assert.equal(layerOf('src/runner/git-sync/ci.ts'), 'runner');
  assert.equal(layerOf('src/server.ts'), null);
  assert.equal(layerOf('src/types/pngjs.d.ts'), null);
  assert.equal(resolveImport('src/runner/runner.ts', '../api/bugs.js'), 'src/api/bugs.ts');
  assert.equal(resolveImport('src/runner/git-sync/ci.ts', '../../core/log.js'), 'src/core/log.ts');
});

test('layerViolations: nur Importe nach oben, Einstiege ausgenommen', () => {
  const edges = [
    { from: 'src/api/x.ts', to: 'src/runner/y.ts' },
    { from: 'src/runner/y.ts', to: 'src/api/x.ts' },
    { from: 'src/core/a.ts', to: 'src/agent/b.ts' },
    { from: 'src/core/a.ts', to: 'src/core/c.ts' },
    { from: 'src/server.ts', to: 'src/api/x.ts' },
  ];
  assert.deepEqual(layerViolations(edges), [
    { from: 'src/runner/y.ts', to: 'src/api/x.ts' },
    { from: 'src/core/a.ts', to: 'src/agent/b.ts' },
  ]);
});

test('findCycles: findet Ringe, ignoriert Bäume', () => {
  const edges = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'c', to: 'a' },
    { from: 'c', to: 'd' },
    { from: 'x', to: 'y' },
    { from: 'y', to: 'x' },
    { from: 'd', to: 'e' },
  ];
  assert.deepEqual(findCycles(edges), [
    ['a', 'b', 'c'],
    ['x', 'y'],
  ]);
});

test('evaluate: Baseline duldet bekannte Verstösse und meldet überholte Einträge', () => {
  const edges = [
    { from: 'src/runner/y.ts', to: 'src/api/x.ts' },
    { from: 'src/db/d.ts', to: 'src/api/x.ts' },
  ];
  const baseline = [
    { from: 'src/runner/y.ts', to: 'src/api/x.ts', why: 'alt' },
    { from: 'src/core/gone.ts', to: 'src/api/x.ts', why: 'behoben' },
  ];
  const result = evaluate(edges, baseline);
  assert.deepEqual(result.violations, [{ from: 'src/db/d.ts', to: 'src/api/x.ts' }]);
  assert.deepEqual(result.stale, [{ from: 'src/core/gone.ts', to: 'src/api/x.ts', why: 'behoben' }]);
  assert.deepEqual(result.cycles, []);
});

test('rebuildBaseline: behält Begründungen, markiert Neues', () => {
  const edges = [
    { from: 'src/runner/y.ts', to: 'src/api/x.ts' },
    { from: 'src/agent/a.ts', to: 'src/api/x.ts' },
  ];
  const next = rebuildBaseline(edges, [{ from: 'src/runner/y.ts', to: 'src/api/x.ts', why: 'bekannt' }]);
  assert.deepEqual(next, [
    { from: 'src/agent/a.ts', to: 'src/api/x.ts', why: 'TODO: Begründung ergänzen oder Verstoss beheben.' },
    { from: 'src/runner/y.ts', to: 'src/api/x.ts', why: 'bekannt' },
  ]);
});

test('collectEdges: liest src/, lässt Tests, Typdeklarationen und Typ-Importe aus', () => {
  const root = mkdtempSync(join(tmpdir(), 'dev-log-layers-'));
  try {
    mkdirSync(join(root, 'src', 'core'), { recursive: true });
    mkdirSync(join(root, 'src', 'api'), { recursive: true });
    writeFileSync(join(root, 'src', 'core', 'a.ts'), `import type { X } from '../api/x.js';\nexport const a = 1;\n`);
    writeFileSync(join(root, 'src', 'api', 'x.ts'), `import { a } from '../core/a.js';\nexport type X = number;\n`);
    writeFileSync(join(root, 'src', 'api', 'x.test.ts'), `import { a } from '../core/a.js';\n`);
    writeFileSync(join(root, 'src', 'core', 'types.d.ts'), `import { a } from '../api/x.js';\n`);
    assert.deepEqual(collectEdges(root), [{ from: 'src/api/x.ts', to: 'src/core/a.ts' }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
