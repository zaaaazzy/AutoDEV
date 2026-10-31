import type { ProjectStats } from '../../core/models.js';

type SprintVelocity = ProjectStats['velocity'][number];

/** Schätzfehler als Faktor („2,4×“); ohne Wert „–“ statt 0. */
export function errorText(value: number | null | undefined): string {
  return value === null || value === undefined
    ? '–'
    : `${value.toLocaleString('de-DE', { maximumFractionDigits: value < 0.1 ? 3 : 2 })}×`;
}

/**
 * Verlauf des Schätzfehlers über die Sprints in ihrer Reihenfolge (die API liefert den ältesten zuerst). Die
 * Balkenbreite ist logarithmisch um 1× zentriert (0,01× bis 100×): 50 % = genau geschätzt, kürzer = weniger
 * verbraucht als geschätzt, länger = mehr. Sprints ohne Wert zeigen keinen Balken.
 */
export function estimateTrend(velocity: readonly SprintVelocity[]): (SprintVelocity & { width: number })[] {
  return velocity.map((row) => {
    const error = row.hourError ?? null;
    const width = error && error > 0 ? Math.max(2, Math.min(100, 50 + (Math.log10(error) / 2) * 50)) : 0;
    return { ...row, width: Math.round(width) };
  });
}
