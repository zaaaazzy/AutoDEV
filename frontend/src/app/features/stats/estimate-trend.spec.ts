import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorText, estimateTrend } from './estimate-trend.js';

const sprint = (name: string, hourError: number | null) => ({
  name,
  status: 'completed',
  total: 3,
  done: hourError === null ? 0 : 3,
  hours: 1,
  hourError,
  tokenError: null,
  errorSamples: hourError === null ? 0 : 3,
});

test('Schätzfehler-Verlauf: Sprints in ihrer Reihenfolge, ohne Wert kein Balken statt 0', () => {
  const trend = estimateTrend([sprint('S1', 0.04), sprint('S2', null), sprint('S3', 1), sprint('S4', 10)]);
  assert.deepEqual(
    trend.map((row) => [row.name, row.width]),
    [
      ['S1', 15],
      ['S2', 0],
      ['S3', 50],
      ['S4', 75],
    ],
  );
  assert.equal(errorText(null), '–');
  assert.equal(errorText(undefined), '–');
  assert.equal(errorText(2.346), '2,35×');
  assert.equal(errorText(0.042), '0,042×');
  assert.deepEqual(estimateTrend([]), []);
});
