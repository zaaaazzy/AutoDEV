import type { EstimateOverrun } from '../../core/models.js';
import { formatHours, formatNumber } from '../../shared/format.js';

/** Was überschritten ist, z. B. „Laufzeit 6,2 h statt 2 h (3,1×) · Tokens 400.000 statt 100.000 (4×)“. */
export function overrunText(entry: EstimateOverrun): string {
  const factor = (ratio: number | null): string =>
    ratio === null ? '' : ` (${ratio.toLocaleString('de-DE', { maximumFractionDigits: 1 })}×)`;
  const hours = `Laufzeit ${formatHours(entry.actual.hours)} statt ${formatHours(entry.calibrated.hours)}`;
  const tokens = `Tokens ${formatNumber(entry.actual.tokens)} statt ${formatNumber(entry.calibrated.tokens)}`;
  return [
    entry.exceeded.hours ? hours + factor(entry.ratio.hours) : '',
    entry.exceeded.tokens ? tokens + factor(entry.ratio.tokens) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
