import assert from 'node:assert/strict';
import test from 'node:test';
import { areaName, mergeCoverage, parseNodeCoverage, splitArgs } from './measured-coverage.js';

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
  assert.match(merged.summary, /Gemessen von Dev Log/);
  assert.equal(mergeCoverage(null, []), null);
});
