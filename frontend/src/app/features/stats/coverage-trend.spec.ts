import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CoverageTrendPoint } from '../../core/models.js';
import { CHART, linePath, plotted, xPositions, yPosition } from './coverage-trend.js';

const point = (date: string, lines: number | null, branches: number | null = 50): CoverageTrendPoint => ({
  reportId: date,
  date,
  lines,
  branches,
  tests: 3,
});

test('Zeitreihe: fehlender Zeilenwert ist eine Lücke im Pfad, nicht 0 %', () => {
  const points = [point('2026-10-01', 40), point('2026-10-02', null), point('2026-10-03', 60), point('2026-10-04', 70)];
  const lines = plotted(points, 'lines');
  assert.equal(lines[1], null);
  const path = linePath(lines);
  assert.equal(path.match(/M/g)?.length, 2, 'neuer Teilpfad nach der Lücke');
  assert.ok(!path.includes(`,${yPosition(0).toFixed(1)}`), 'kein Punkt bei 0 %');
});

test('Zeitreihe: x nach Datum, y 0–100 von unten nach oben, einzelner Punkt mittig', () => {
  const xs = xPositions([point('2026-10-01', 1), point('2026-10-02', 1), point('2026-10-11', 1)]);
  assert.equal(xs[0], CHART.left);
  assert.equal(xs[2], CHART.width - CHART.right);
  assert.ok(xs[1]! - xs[0]! < (xs[2]! - xs[1]!) / 2, 'Abstand folgt der Zeit');
  assert.equal(yPosition(100), CHART.top);
  assert.equal(yPosition(0), CHART.height - CHART.bottom);
  const [single] = xPositions([point('2026-10-01', 1)]);
  assert.equal(single, CHART.left + (CHART.width - CHART.left - CHART.right) / 2);
});
