import assert from 'node:assert/strict';
import { test } from 'node:test';
import { overrunText } from './estimate-overruns.js';

const entry = {
  id: 'd1',
  title: 'Export',
  status: 'in_progress',
  actual: { hours: 6.2, tokens: 400_000 },
  calibrated: { hours: 2, tokens: 100_000 },
  ratio: { hours: 3.1, tokens: 4 },
  exceeded: { hours: true, tokens: false },
  scope: 'segment',
};

test('Laufwarnung: nur überschrittene Werte mit Faktor gegenüber der kalibrierten Schätzung', () => {
  assert.equal(overrunText(entry), 'Laufzeit 6,2 h statt 2 h (3,1×)');
  assert.equal(
    overrunText({ ...entry, exceeded: { hours: true, tokens: true } }),
    'Laufzeit 6,2 h statt 2 h (3,1×) · Tokens 400.000 statt 100.000 (4×)',
  );
  assert.equal(overrunText({ ...entry, exceeded: { hours: false, tokens: false } }), '');
});
