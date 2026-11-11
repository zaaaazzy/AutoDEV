import { COVERAGE_AREA_KEYS, COVERAGE_AREA_LABELS } from '../../../../../src/core/coverage-areas.js';
import type { CoverageAreaKey, CoverageHistoryPoint } from '../../core/models.js';
import { defined } from '../../../../../src/core/defined.js';

/** Ziel der Zeilenabdeckung (wie beim Tester und im Dashboard). */
export const COVERAGE_TARGET = 75;
export const CHART_WIDTH = 240;
export const CHART_HEIGHT = 64;
const CHART_PAD = 6;

export interface CoverageSeries {
  area: CoverageAreaKey;
  label: string;
  points: { lines: number; createdAt: string; x: number; y: number }[];
  /** SVG-Pfad der Linie (viewBox 0 0 CHART_WIDTH CHART_HEIGHT). */
  path: string;
  last: number;
}

/** Y-Position eines Prozentwerts im Verlaufsdiagramm (0 % unten, 100 % oben). */
export const chartY = (percent: number): number => CHART_PAD + (1 - percent / 100) * (CHART_HEIGHT - 2 * CHART_PAD);

/** Verlauf der Zeilenabdeckung je Bereichsschlüssel (feste Reihenfolge), x nach Datum, y nach Prozent. */
export function coverageSeries(history: CoverageHistoryPoint[]): CoverageSeries[] {
  const times = history.map((point) => Date.parse(point.createdAt));
  const min = Math.min(...times);
  const span = Math.max(...times) - min;
  return COVERAGE_AREA_KEYS.flatMap((area) => {
    const points = history
      .filter((point) => point.area === area)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map((point) => {
        const offset = span > 0 ? (Date.parse(point.createdAt) - min) / span : 0.5;
        const x = CHART_PAD + offset * (CHART_WIDTH - 2 * CHART_PAD);
        // REAL aus der Datenbank (81.4000015…) auf eine Nachkommastelle.
        const lines = Math.round(point.lines * 10) / 10;
        return { lines, createdAt: point.createdAt, x, y: chartY(lines) };
      });
    if (!points.length) return [];
    const path = points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`);
    return [
      { area, label: COVERAGE_AREA_LABELS[area], points, path: path.join(' '), last: defined(points.at(-1)).lines },
    ];
  });
}
