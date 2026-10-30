/**
 * Gemeinsame Regeln der kalibrierten Schätzung für API und Oberfläche (ohne Datenbank-Abhängigkeit): Art und
 * Schrittklasse eines Auftrags (Gruppen der Kalibrierung) und die Schwelle, ab der ein laufender Auftrag seine
 * kalibrierte Schätzung überschreitet.
 */

/** Art eines Auftrags in der Kalibrierung; Express-Aufträge werden nicht geschätzt und zählen nicht. */
export type OrderKind = 'feature' | 'bug';

export const ORDER_KIND_LABELS: Record<OrderKind, string> = { feature: 'Feature', bug: 'Bugfix' };

export const kindOf = (value: string | null | undefined): OrderKind => (value === 'bug' ? 'bug' : 'feature');

/** Schrittklasse: Agent-Schritte über alle Läufe eines Auftrags. */
export type StepClass = 'small' | 'medium' | 'large';

/** Obergrenzen der Schrittklassen „bis 10“ und „11 bis 20“; darüber „mehr als 20“. */
export const STEP_CLASS_LIMITS = { small: 10, medium: 20 } as const;

export const STEP_CLASS_LABELS: Record<StepClass, string> = {
  small: `bis ${STEP_CLASS_LIMITS.small} Schritte`,
  medium: `${STEP_CLASS_LIMITS.small + 1} bis ${STEP_CLASS_LIMITS.medium} Schritte`,
  large: `mehr als ${STEP_CLASS_LIMITS.medium} Schritte`,
};

export function stepClassOf(steps: number): StepClass {
  if (steps <= STEP_CLASS_LIMITS.small) return 'small';
  return steps <= STEP_CLASS_LIMITS.medium ? 'medium' : 'large';
}

/** Ein laufender Auftrag gilt als überschritten, wenn er mehr als das Dreifache der kalibrierten Schätzung verbraucht. */
export const OVERRUN_FACTOR = 3;

/** Ist ÷ kalibrierte Schätzung; null ohne brauchbare Werte (Schätzung fehlt, ist 0 oder ungültig). */
function rawRatio(actual: number | null | undefined, calibrated: number | null | undefined): number | null {
  if (actual === null || actual === undefined || !Number.isFinite(actual) || actual < 0) return null;
  if (calibrated === null || calibrated === undefined || !Number.isFinite(calibrated) || calibrated <= 0) return null;
  return actual / calibrated;
}

/** Verhältnis Ist ÷ kalibrierte Schätzung für die Anzeige, auf drei Stellen gerundet. */
export function overrunRatio(actual: number | null | undefined, calibrated: number | null | undefined): number | null {
  const ratio = rawRatio(actual, calibrated);
  return ratio === null ? null : Math.round(ratio * 1000) / 1000;
}

/**
 * Überschritten: strikt mehr als `OVERRUN_FACTOR`; genau das Dreifache nicht, auch wenn etwa 0,9 ÷ 0,3 als
 * Gleitkommazahl knapp über 3 liegt. Ohne brauchbare Schätzung nie (keine Warnung, keine Blockade).
 */
export function exceedsEstimate(actual: number | null | undefined, calibrated: number | null | undefined): boolean {
  const ratio = rawRatio(actual, calibrated);
  return ratio !== null && ratio > OVERRUN_FACTOR * (1 + 1e-9);
}
