import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chartY, coverageSeries } from './coverage-history.js';

test('Testabdeckung-Verlauf: je Schlüssel eine Linie in fester Reihenfolge, Punkte nach Datum', () => {
  const series = coverageSeries([
    { area: 'gesamt', lines: 70, createdAt: '2026-10-10T10:00:00Z' },
    { area: 'backend', lines: 80.40000152587891, createdAt: '2026-10-20T10:00:00Z' },
    { area: 'backend', lines: 60, createdAt: '2026-10-01T10:00:00Z' },
  ]);
  assert.deepEqual(
    series.map((entry) => [entry.area, entry.label, entry.last]),
    [
      ['backend', 'Backend', 80.4],
      ['gesamt', 'Gesamt', 70],
    ],
  );
  const backend = series[0]!;
  assert.deepEqual(
    backend.points.map((point) => [point.createdAt, point.lines]),
    [
      ['2026-10-01T10:00:00Z', 60],
      ['2026-10-20T10:00:00Z', 80.4],
    ],
  );
  // x nach Datum über alle Bereiche: erster Lauf links, letzter rechts, dazwischen anteilig.
  assert.ok(backend.points[0]!.x < series[1]!.points[0]!.x && series[1]!.points[0]!.x < backend.points[1]!.x);
  assert.equal(backend.points[0]!.y, chartY(60));
  assert.match(backend.path, /^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+$/);
  assert.ok(chartY(100) < chartY(0), '100 % oben');
  assert.deepEqual(coverageSeries([]), []);
});
