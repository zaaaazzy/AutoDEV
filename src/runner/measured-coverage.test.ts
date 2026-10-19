import assert from 'node:assert/strict';
import test from 'node:test';
import {
  areaName,
  measureCoverage,
  mergeCoverage,
  parseNodeCoverage,
  splitArgs,
  testRunnerOf,
} from './measured-coverage.js';

test('reads the node test runner coverage summary', () => {
  const output = `# tests 64\n# pass 63\n# fail 1\n# file | line % | branch % | funcs % | uncovered lines\n# all files                    |  84.02 |    82.64 |   91.78 |\n`;
  assert.deepEqual(parseNodeCoverage(output), {
    lines: 84.02,
    branches: 82.64,
    functions: 91.78,
    passed: 63,
    failed: 1,
  });
  assert.equal(parseNodeCoverage('# tests 3'), null);
});

test('splits script arguments and names areas', () => {
  assert.deepEqual(splitArgs(` "src/**/*.test.ts" --x 'a b'`), ['src/**/*.test.ts', '--x', 'a b']);
  assert.equal(areaName('mainty-backend'), 'Backend');
  assert.equal(areaName('@mainty/contracts'), 'Contracts');
  assert.equal(areaName('tools'), 'tools');
});

test('measured percentages fill the tester report', () => {
  const measured = [
    {
      area: 'Backend',
      unit: 64,
      component: 0,
      integration: 0,
      e2e: 0,
      passed: 64,
      failed: 0,
      lines: 84,
      statements: null,
      branches: 82,
      functions: 91,
    },
  ];
  const reported = {
    summary: 'Tester',
    areas: [
      {
        area: 'backend',
        unit: 0,
        component: 0,
        integration: 0,
        e2e: 0,
        passed: 69,
        failed: 0,
        lines: null,
        statements: null,
        branches: null,
        functions: null,
      },
    ],
  };
  const merged = mergeCoverage(reported, measured)!;
  assert.equal(merged.areas.length, 1);
  assert.equal(merged.areas[0]!.lines, 84);
  assert.equal(merged.areas[0]!.passed, 69);
  assert.equal(merged.areas[0]!.unit, 64);
  assert.match(merged.summary, /Gemessen von AIdeation/);
  assert.equal(mergeCoverage(null, []), null);
});

test('findet den Test-Runner auch hinter „&&“ und über „npm run“', () => {
  const scripts = {
    test: 'npm run build:ui && npm run test:unit',
    'test:unit': 'tsx --test "src/**/*.test.ts" "frontend/src/**/*.spec.ts"',
    'build:ui': 'ng build',
  };
  assert.deepEqual(testRunnerOf('npm run build:ui && tsx --test "a" "b"', {}), {
    binary: 'tsx',
    args: ['a', 'b'],
    setup: [['npm', 'run', 'build:ui']],
  });
  assert.deepEqual(testRunnerOf(scripts.test, scripts), {
    binary: 'tsx',
    args: ['src/**/*.test.ts', 'frontend/src/**/*.spec.ts'],
    setup: [['npm', 'run', 'build:ui']],
  });
  assert.equal(testRunnerOf('vitest run', {}), null);
  // Endlose Verweise brechen ab statt zu hängen.
  assert.equal(testRunnerOf('npm run a', { a: 'npm run a' }), null);
});

test('misst AIdeation selbst: erst vorbereiten, dann mit Abdeckung testen', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'coverage-'));
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'dev-log', scripts: { test: 'npm run build:ui && tsx --test "src/**/*.test.ts"' } }),
  );
  const calls: string[][] = [];
  const areas = await measureCoverage(dir, [['npm', 'test']], async (command) => {
    calls.push(command);
    const output = command.includes('--experimental-test-coverage')
      ? '# pass 5\n# fail 0\n# all files | 80.5 | 70.25 | 90 |\n'
      : '';
    return { exitCode: 0, durationMs: 1, output };
  });
  assert.deepEqual(calls[0], ['npm', 'run', 'build:ui']);
  assert.ok(calls[1]?.includes('--experimental-test-coverage'));
  assert.ok(calls[1]?.includes('src/**/*.test.ts'));
  assert.equal(areas[0]?.lines, 80.5);
  assert.equal(areas[0]?.passed, 5);
});
