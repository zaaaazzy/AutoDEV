import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCoverage, stripCoverage } from './coverage.js';

const BLOCK =
  '@@COVERAGE {"summary":"3 Tests ergänzt","areas":[{"area":"Frontend","unit":100,"component":36,"integration":0,"e2e":2,"passed":138,"failed":0,"lines":81.4,"statements":80.9,"branches":62,"functions":"74.5"},{"area":"Backend","unit":50,"integration":19,"lines":null}]}';

test('parses the tester coverage block per area', () => {
  const report = parseCoverage(`Alle Tests grün.\n${BLOCK}`);
  assert.equal(report?.summary, '3 Tests ergänzt');
  assert.deepEqual(report?.areas[0], {
    area: 'Frontend',
    unit: 100,
    component: 36,
    integration: 0,
    e2e: 2,
    passed: 138,
    failed: 0,
    lines: 81.4,
    statements: 80.9,
    branches: 62,
    functions: 74.5,
  });
  assert.equal(report?.areas[1]?.integration, 19);
  assert.equal(report?.areas[1]?.lines, null);
  assert.equal(stripCoverage(`Alle Tests grün.\n${BLOCK}`), 'Alle Tests grün.');
});

test('ignores missing or broken coverage blocks', () => {
  assert.equal(parseCoverage('Keine Messung.'), null);
  assert.equal(parseCoverage('@@COVERAGE {kaputt}'), null);
  assert.equal(parseCoverage('@@COVERAGE {"areas":[]}'), null);
});
