import type { Pool } from 'pg';

/**
 * Kalibrierung der Schätzungen: Planer, Modell-Routing und Statistik rechnen in Agent-Stunden (gemessene Laufzeit
 * aller Agent-Schritte) und gemessenen Tokens. Schätzungen weichen davon ab – der Altbestand ist in Menschenstunden
 * geschätzt (rund 30-mal zu hoch), Tokens werden meist unterschätzt. Der Faktor je Herkunft ist der Median von
 * Ist ÷ Schätzung der letzten erledigten Aufträge; jede Herkunft wird getrennt kalibriert, weil sie verschieden
 * schätzt (von Hand, Schnellschätzung, Auftragsautor, Altbestand).
 */
export type EstimateSource = 'manual' | 'quick' | 'author' | 'legacy';

export interface CalibrationFactor {
  /** Faktor für Stunden bzw. Tokens (Ist ÷ Schätzung). */
  hours: number;
  tokens: number;
  /** Erledigte Aufträge mit Messung, auf denen der Stundenfaktor beruht (0 = Standard 1). */
  samples: number;
  /** Woher der Stundenfaktor stammt: dieses Projekt, alle Projekte oder Standard (zu wenig Messwerte). */
  scope: 'project' | 'all' | 'default';
}

export type Calibration = Record<EstimateSource, CalibrationFactor>;

/** Ab so vielen Messwerten gilt ein Faktor; darunter der Wert aller Projekte, sonst 1. */
export const MIN_CALIBRATION_SAMPLES = 5;
/** Je Projekt und Herkunft zählen nur die jüngsten erledigten Aufträge (Schätzweise ändert sich mit der Zeit). */
export const CALIBRATION_WINDOW = 20;
const MIN_FACTOR = 0.01;
const MAX_FACTOR = 10;

export const ESTIMATE_SOURCES: readonly EstimateSource[] = ['manual', 'quick', 'author', 'legacy'];

export const ESTIMATE_SOURCE_LABELS: Record<EstimateSource, string> = {
  manual: 'von Hand',
  quick: 'Schnellschätzung',
  author: 'Auftragsautor',
  legacy: 'Altbestand',
};

const DEFAULT_FACTOR: CalibrationFactor = { hours: 1, tokens: 1, samples: 0, scope: 'default' };

export const UNCALIBRATED: Calibration = {
  manual: DEFAULT_FACTOR,
  quick: DEFAULT_FACTOR,
  author: DEFAULT_FACTOR,
  legacy: DEFAULT_FACTOR,
};

/** Gemessene Faktoren einer Herkunft (aus der Datenbank, siehe `loadCalibration`). */
export interface RatioRow {
  own: boolean;
  source: EstimateSource;
  hourSamples: number;
  hourRatio: number | null;
  tokenSamples: number;
  tokenRatio: number | null;
}

const clamp = (value: number): number => Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, value));
const round = (value: number): number => Math.round(value * 1000) / 1000;

function pick(
  own: number | null,
  ownSamples: number,
  all: number | null,
  allSamples: number,
): { factor: number; samples: number; scope: CalibrationFactor['scope'] } {
  if (own !== null && ownSamples >= MIN_CALIBRATION_SAMPLES)
    return { factor: round(clamp(own)), samples: ownSamples, scope: 'project' };
  if (all !== null && allSamples >= MIN_CALIBRATION_SAMPLES)
    return { factor: round(clamp(all)), samples: allSamples, scope: 'all' };
  return { factor: 1, samples: 0, scope: 'default' };
}

/** Faktoren je Herkunft: erst das Projekt, sonst alle Projekte, sonst 1. Stunden und Tokens unabhängig. */
export function calibrationFrom(rows: RatioRow[]): Calibration {
  const calibration = { ...UNCALIBRATED };
  for (const source of ESTIMATE_SOURCES) {
    const own = rows.find((row) => row.own && row.source === source);
    const all = rows.find((row) => !row.own && row.source === source);
    const hours = pick(own?.hourRatio ?? null, own?.hourSamples ?? 0, all?.hourRatio ?? null, all?.hourSamples ?? 0);
    const tokens = pick(
      own?.tokenRatio ?? null,
      own?.tokenSamples ?? 0,
      all?.tokenRatio ?? null,
      all?.tokenSamples ?? 0,
    );
    calibration[source] = { hours: hours.factor, tokens: tokens.factor, samples: hours.samples, scope: hours.scope };
  }
  return calibration;
}

export const sourceOf = (value: string | null | undefined): EstimateSource =>
  value === 'manual' || value === 'quick' || value === 'author' ? value : 'legacy';

/** Kalibrierte Agent-Stunden einer Schätzung (null bleibt null). */
export function calibratedHours(
  hours: number | null,
  source: string | null | undefined,
  calibration: Calibration,
): number | null {
  return hours === null ? null : Math.round(hours * calibration[sourceOf(source)].hours * 100) / 100;
}

/** Kalibrierte Tokens einer Schätzung (null bleibt null). */
export function calibratedTokens(
  tokens: number | null,
  source: string | null | undefined,
  calibration: Calibration,
): number | null {
  return tokens === null ? null : Math.round(tokens * calibration[sourceOf(source)].tokens);
}

/** Gemessener Verbrauch bzw. kalibrierte Schätzung eines Auftrags (Agent-Stunden und Tokens). */
export interface Effort {
  hours: number | null;
  tokens: number | null;
}

/** Treffer: Ist liegt bei Stunden und Tokens zwischen dem 0,5- und dem 2,0-Fachen der kalibrierten Schätzung. */
export const HIT_RANGE = { min: 0.5, max: 2 } as const;

/**
 * Trefferprüfung eines erledigten Auftrags; null = nicht gemessen (Stunden- oder Tokenschätzung fehlt bzw. ist 0,
 * oder es gibt keinen Verbrauch). Grenzen zählen als Treffer.
 */
export function estimateHit(actual: Effort, estimate: Effort): boolean | null {
  const { hours: estHours, tokens: estTokens } = estimate;
  if (!estHours || !estTokens || estHours <= 0 || estTokens <= 0) return null;
  const hours = actual.hours ?? 0;
  const tokens = actual.tokens ?? 0;
  if (hours <= 0 && tokens <= 0) return null;
  const inRange = (ratio: number) => ratio >= HIT_RANGE.min && ratio <= HIT_RANGE.max;
  return inRange(hours / estHours) && inRange(tokens / estTokens);
}

export interface HitRate {
  hits: number;
  measured: number;
  /** Treffer in Prozent; null ohne gemessene Aufträge (Anzeige „–“ statt 0 %). */
  percent: number | null;
}

export function hitRate(results: (boolean | null)[]): HitRate {
  const measured = results.filter((result) => result !== null);
  const hits = measured.filter(Boolean).length;
  const percent = measured.length ? Math.round((hits / measured.length) * 100) : null;
  return { hits, measured: measured.length, percent };
}

/** Ab dem Überschreiten dieses Vielfachen der kalibrierten Schätzung startet kein weiterer Schritt. */
export const OVERRUN_FACTOR = 3;

/**
 * Überschreitet der Ist-Wert eines laufenden Auftrags das Dreifache der kalibrierten Schätzung (Stunden oder Tokens)?
 * Genau das Dreifache läuft weiter. Ohne Schätzung (null bzw. 0) wird der jeweilige Wert nicht geprüft.
 */
export function estimateOverrun(actual: Effort, estimate: Effort): { hours: boolean; tokens: boolean } | null {
  const over = (value: number | null, limit: number | null) =>
    limit !== null && limit > 0 && (value ?? 0) > limit * OVERRUN_FACTOR;
  const hours = over(actual.hours, estimate.hours);
  const tokens = over(actual.tokens, estimate.tokens);
  return hours || tokens ? { hours, tokens } : null;
}

/** Faktoren je Herkunft für die Statistik (Anzeige von Faktor und Anzahl der Messwerte). */
export function calibrationSummary(
  calibration: Calibration,
): ({ source: EstimateSource; label: string } & CalibrationFactor)[] {
  return ESTIMATE_SOURCES.map((source) => ({ source, label: ESTIMATE_SOURCE_LABELS[source], ...calibration[source] }));
}

/**
 * Gemessene Ist-Werte erledigter Aufträge: je Auftrag Summe von Laufzeit und Tokens aller Agent-Schritte, davon die
 * jüngsten `CALIBRATION_WINDOW` je Projekt und Herkunft. Ergebnis: Median von Ist ÷ Schätzung für das Projekt
 * (`own`) und über alle Projekte.
 */
export const CALIBRATION_SQL = `
  WITH measured AS (
    SELECT d.project_slug, COALESCE(d.estimate_source, 'legacy') AS source, d.completed_at,
           d.effort_hours AS est_hours, d.token_estimate AS est_tokens,
           SUM(st.duration_ms) / 3600000.0 AS hours, SUM(st.tokens) AS tokens
      FROM development_items d
      JOIN agent_runs r ON r.development_id = d.id
      JOIN agent_run_steps st ON st.run_id = r.id
     WHERE d.status = 'done' AND d.kind <> 'express'
     GROUP BY d.id
  ), ranked AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY project_slug, source ORDER BY completed_at DESC NULLS LAST) AS n
      FROM measured
  ), recent AS (
    SELECT *, hours / NULLIF(est_hours, 0) AS hour_ratio, tokens / NULLIF(est_tokens, 0)::float8 AS token_ratio
      FROM ranked WHERE n <= ${CALIBRATION_WINDOW}
  )
  SELECT own, source,
         COUNT(*) FILTER (WHERE hour_ratio > 0) AS "hourSamples",
         percentile_cont(0.5) WITHIN GROUP (ORDER BY hour_ratio) FILTER (WHERE hour_ratio > 0) AS "hourRatio",
         COUNT(*) FILTER (WHERE token_ratio > 0) AS "tokenSamples",
         percentile_cont(0.5) WITHIN GROUP (ORDER BY token_ratio) FILTER (WHERE token_ratio > 0) AS "tokenRatio"
    FROM (SELECT TRUE AS own, * FROM recent WHERE project_slug = $1
          UNION ALL SELECT FALSE AS own, * FROM recent) scoped
   GROUP BY own, source`;

export async function loadCalibration(pool: Pick<Pool, 'query'>, project: string): Promise<Calibration> {
  const rows = (
    await pool.query<{
      own: boolean;
      source: string;
      hourSamples: string;
      hourRatio: number | null;
      tokenSamples: string;
      tokenRatio: number | null;
    }>(CALIBRATION_SQL, [project])
  ).rows;
  return calibrationFrom(
    rows.map((row) => ({
      own: row.own,
      source: sourceOf(row.source),
      hourSamples: Number(row.hourSamples),
      hourRatio: row.hourRatio === null ? null : Number(row.hourRatio),
      tokenSamples: Number(row.tokenSamples),
      tokenRatio: row.tokenRatio === null ? null : Number(row.tokenRatio),
    })),
  );
}

/**
 * SQL-Ausdruck für die kalibrierte Schätzung einer Zeile (für Summen in der Statistik). Die Faktoren sind
 * berechnete Zahlen zwischen 0,01 und 10 und werden als Literal eingesetzt.
 */
export function calibratedSql(column: 'effort_hours' | 'token_estimate', calibration: Calibration, alias = ''): string {
  const kind = column === 'effort_hours' ? 'hours' : 'tokens';
  const prefix = alias ? `${alias}.` : '';
  const cases = ESTIMATE_SOURCES.filter((source) => source !== 'legacy')
    .map((source) => `WHEN '${source}' THEN ${Number(calibration[source][kind])}`)
    .join(' ');
  return `(${prefix}${column} * CASE ${prefix}estimate_source ${cases} ELSE ${Number(calibration.legacy[kind])} END)`;
}

/** Zeilen mit `effortHours` und `estimateSource` um `calibratedHours` (Agent-Stunden) ergänzen. */
export function withCalibratedHours<T extends { effortHours?: number | null; estimateSource?: string | null }>(
  rows: T[],
  calibration: Calibration,
): (T & { calibratedHours: number | null })[] {
  return rows.map((row) => ({
    ...row,
    calibratedHours: calibratedHours(row.effortHours ?? null, row.estimateSource, calibration),
  }));
}
