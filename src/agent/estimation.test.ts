import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEstimate, splitEstimate } from './estimation.js';

test('splitEstimate separates the requirement from the estimate section', () => {
  const output =
    '## Ziel\nLogin\n\n## Schätzung\n```json\n{"effortHours": 3, "tokenEstimate": 120000, "benefit": 7, "cost": 4}\n```';
  const { requirement, estimate } = splitEstimate(output);
  assert.equal(requirement, '## Ziel\nLogin');
  assert.deepEqual(estimate, { effortHours: 3, tokenEstimate: 120000, benefit: 7, cost: 4 });
});

test('splitEstimate keeps the text when the estimate is missing or invalid', () => {
  assert.deepEqual(splitEstimate('## Ziel\nNur Text'), { requirement: '## Ziel\nNur Text', estimate: null });
  assert.equal(splitEstimate('## Ziel\nX\n## Schätzung\nkeine Ahnung').estimate, null);
  assert.equal(splitEstimate('## Ziel\nX\n## Schätzung\n{"effortHours": -5}').estimate, null);
});

test('parseEstimate reads a bare JSON answer', () => {
  assert.equal(parseEstimate('{"effortHours": 2, "tokenEstimate": 5000}')?.effortHours, 2);
  assert.equal(parseEstimate('kein json'), null);
});

test('parseEstimate ignores braces in CLI banners and logs', () => {
  const output = 'warn {deprecated} flag\n{"effortHours": 3, "benefit": 7}\nlog: {done}';
  assert.equal(parseEstimate(output)?.effortHours, 3);
  assert.equal(parseEstimate(output)?.benefit, 7);
});
