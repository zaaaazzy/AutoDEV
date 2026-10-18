import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate } from './watchdog.js';

const calm = { problems: [], notifiedAt: null };

test('reports new problems immediately, stays quiet while unchanged, reminds after six hours', () => {
  const first = evaluate(calm, ['Worker meldet sich nicht.'], 1_000);
  assert.equal(first.message?.title, '⚠ Dev Log: Problem erkannt');
  assert.equal(first.state.notifiedAt, 1_000);

  const same = evaluate(first.state, ['Worker meldet sich nicht.'], 60_000);
  assert.equal(same.message, null);

  const later = evaluate(first.state, ['Worker meldet sich nicht.'], 1_000 + 6 * 3600 * 1000);
  assert.equal(later.message?.title, '⚠ Dev Log: Problem besteht weiterhin');

  const added = evaluate(first.state, ['Worker meldet sich nicht.', 'Backup fehlt.'], 120_000);
  assert.match(added.message?.body ?? '', /Backup fehlt/);
});

test('reports recovery once and nothing when all is well', () => {
  const recovered = evaluate({ problems: ['x'], notifiedAt: 5 }, [], 10);
  assert.equal(recovered.message?.title, '✓ Dev Log läuft wieder');
  assert.equal(evaluate(recovered.state, [], 20).message, null);
});
