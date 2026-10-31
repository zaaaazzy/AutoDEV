import type { ProjectStats } from '../../core/models.js';

type SprintVelocity = ProjectStats['velocity'][number];

/** Trefferquote der Schätzung: „67 % (2 von 3)“; ohne gemessene Aufträge „–“ statt 0 %. */
export function hitRateText(rate: SprintVelocity['hitRate']): string {
  if (!rate || rate.percent === null || !rate.measured) return '–';
  return `${rate.percent} % (${rate.hits} von ${rate.measured})`;
}

/** Korrekturfaktor einer Herkunft: „Faktor 0,8 h / 1,2 Tokens · 12 Messwerte“ bzw. Standard bei zu wenig Messwerten. */
export function calibrationText(entry: NonNullable<ProjectStats['calibration']>[number]): string {
  const factor = (value: number) => value.toLocaleString('de-DE', { maximumFractionDigits: 3 });
  if (entry.scope === 'default') return 'Faktor 1 (unter 5 Messwerten)';
  return (
    `Faktor ${factor(entry.hours)} (Stunden) / ${factor(entry.tokens)} (Tokens) · ${entry.samples} Messwerte` +
    (entry.scope === 'all' ? ', alle Projekte' : '')
  );
}
