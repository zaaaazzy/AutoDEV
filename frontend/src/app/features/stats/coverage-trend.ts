import type { CoverageTrendPoint } from '../../core/models.js';
import { defined } from '../../../../../src/core/defined.js';

/** Zeichenfläche einer Zeitreihe (viewBox), Prozent 0–100 von unten nach oben. */
export const CHART = { width: 320, height: 120, left: 28, right: 8, top: 8, bottom: 8 };

export interface PlottedPoint {
  x: number;
  y: number;
  value: number;
  point: CoverageTrendPoint;
}

/** x-Position nach Datum (gleichmässig in der Zeit, nicht nach Anzahl); ein einzelner Punkt steht in der Mitte. */
export function xPositions(points: CoverageTrendPoint[]): number[] {
  const times = points.map((point) => new Date(point.date).getTime());
  const first = Math.min(...times);
  const span = Math.max(...times) - first;
  const inner = CHART.width - CHART.left - CHART.right;
  return times.map((time) => CHART.left + (span > 0 ? ((time - first) / span) * inner : inner / 2));
}

export function yPosition(percent: number): number {
  const inner = CHART.height - CHART.top - CHART.bottom;
  return CHART.top + (1 - Math.min(100, Math.max(0, percent)) / 100) * inner;
}

/** Gezeichnete Punkte einer Kennzahl; fehlende Werte (null) fallen weg und bilden eine Lücke, nie 0 %. */
export function plotted(points: CoverageTrendPoint[], key: 'lines' | 'branches'): (PlottedPoint | null)[] {
  const xs = xPositions(points);
  return points.map((point, index) => {
    const value = point[key];
    return value === null ? null : { x: defined(xs[index]), y: yPosition(value), value, point };
  });
}

/** SVG-Pfad mit Unterbrechung an jeder Lücke (neues „M“ nach einem fehlenden Wert). */
export function linePath(points: (PlottedPoint | null)[]): string {
  let path = '';
  let open = false;
  for (const point of points) {
    if (!point) {
      open = false;
      continue;
    }
    path += `${open ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`;
    open = true;
  }
  return path;
}
