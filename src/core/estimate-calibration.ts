import type { Pool } from 'pg';
import { defined } from './defined.js';
import {
  exceedsEstimate,
  kindOf,
  overrunRatio,
  ORDER_KIND_LABELS,
  type OrderKind,
  STEP_CLASS_LABELS,
  type StepClass,
  stepClassOf,
} from './estimate-overrun.js';
import { DEVELOPMENT_STATUS } from './status.js';

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

/**
 * Überschreitet der Ist-Wert eines laufenden Auftrags das Dreifache der kalibrierten Schätzung (Stunden oder Tokens)?
 * Gleiche Schwelle wie die Laufwarnung (`exceedsEstimate`), damit Warnung und Stopp nie auseinanderlaufen. Genau das
 * Dreifache läuft weiter. Ohne Schätzung (null bzw. 0) wird der jeweilige Wert nicht geprüft.
 */
export function estimateOverrun(actual: Effort, estimate: Effort): { hours: boolean; tokens: boolean } | null {
  const hours = exceedsEstimate(actual.hours ?? 0, estimate.hours);
  const tokens = exceedsEstimate(actual.tokens ?? 0, estimate.tokens);
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
     WHERE d.status = '${DEVELOPMENT_STATUS.done}' AND d.kind <> 'express'
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
 * Feinere Kalibrierung je Gruppe: Art (Feature/Bugfix), Kategorie und Schrittklasse (Agent-Schritte über alle Läufe
 * eines Auftrags). Fehlen Messwerte, gilt stufenweise die gröbere Gruppe: Art und Kategorie, Art, alle Aufträge des
 * Projekts, alle Projekte, sonst 1. Stunden und Tokens wählen ihre Stufe unabhängig.
 */
export interface Segment {
  kind: OrderKind;
  category: string | null;
  /** null: Schrittzahl unbekannt – die Stufe „Gruppe“ entfällt. */
  stepClass: StepClass | null;
}

export type SegmentScope = 'segment' | 'kindCategory' | 'kind' | 'project' | 'all' | 'default';

export interface SegmentFactor {
  hours: number;
  tokens: number;
  /** Messwerte und Stufe des Stundenfaktors. */
  samples: number;
  scope: SegmentScope;
  /** Messwerte und Stufe des Tokenfaktors. */
  tokenSamples: number;
  tokenScope: SegmentScope;
}

/** Ein erledigter Auftrag mit Messung (neueste zuerst, siehe `MEASURED_ORDERS_SQL`). */
export interface MeasuredOrder {
  project: string;
  source: EstimateSource;
  kind: OrderKind;
  category: string | null;
  steps: number;
  hourRatio: number | null;
  tokenRatio: number | null;
}

/**
 * Alle erledigten Aufträge mit gemessenem Verbrauch, neueste zuerst: Ist ÷ Schätzung je Auftrag und die Zahl der
 * Agent-Schritte über alle Läufe (jeder Status, alle Rollen). Abgeleitet aus `development_items`, `agent_runs` und
 * `agent_run_steps`; ein erledigter Auftrag zählt ab sofort, ein zurückgesetzter (nicht mehr `done`) nicht mehr.
 */
export const MEASURED_ORDERS_SQL = `
  SELECT d.project_slug AS project, COALESCE(d.estimate_source, 'legacy') AS source, d.kind, d.category,
         COUNT(st.id) AS steps,
         (SUM(st.duration_ms) / 3600000.0)::float8 / NULLIF(d.effort_hours, 0) AS "hourRatio",
         SUM(st.tokens)::float8 / NULLIF(d.token_estimate, 0) AS "tokenRatio"
    FROM development_items d
    JOIN agent_runs r ON r.development_id = d.id
    JOIN agent_run_steps st ON st.run_id = r.id
   WHERE d.status = 'done' AND d.kind <> 'express'
   GROUP BY d.id
   ORDER BY d.completed_at DESC NULLS LAST, d.id
   LIMIT 5000`;

const ratioOf = (value: unknown): number | null => {
  const number = value === null || value === undefined ? NaN : Number(value);
  return Number.isFinite(number) ? number : null;
};

export async function loadMeasuredOrders(pool: Pick<Pool, 'query'>): Promise<MeasuredOrder[]> {
  const rows = (
    await pool.query<{
      project: string;
      source: string | null;
      kind: string;
      category: string | null;
      steps: string;
      hourRatio: number | string | null;
      tokenRatio: number | string | null;
    }>(MEASURED_ORDERS_SQL)
  ).rows;
  return rows.map((row) => ({
    project: row.project,
    source: sourceOf(row.source),
    kind: kindOf(row.kind),
    category: row.category ?? null,
    steps: Number(row.steps) || 0,
    hourRatio: ratioOf(row.hourRatio),
    tokenRatio: ratioOf(row.tokenRatio),
  }));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? defined(sorted[middle]) : (defined(sorted[middle - 1]) + defined(sorted[middle])) / 2;
}

/**
 * Je Projekt nur die jüngsten `CALIBRATION_WINDOW` Aufträge der bereits gefilterten Herkünfte. Bei einer einzelnen
 * Herkunft entspricht das `CALIBRATION_SQL`; für den Auftragsautor gilt das Fenster über alle Herkünfte außer `legacy`.
 */
function recentPerProject(orders: MeasuredOrder[]): MeasuredOrder[] {
  const seen = new Map<string, number>();
  return orders.filter((order) => {
    const count = (seen.get(order.project) ?? 0) + 1;
    seen.set(order.project, count);
    return count <= CALIBRATION_WINDOW;
  });
}

/**
 * Faktor einer Gruppe aus den erledigten Aufträgen. `sources`: welche Herkünfte der Schätzung zählen (für den
 * Auftragsautor ohne `legacy`, für einen einzelnen Auftrag dessen eigene Herkunft).
 */
export function segmentFactorFrom(
  orders: MeasuredOrder[],
  project: string,
  segment: Segment,
  sources: readonly EstimateSource[] = ESTIMATE_SOURCES,
): SegmentFactor {
  const usable = orders.filter((order) => sources.includes(order.source));
  const own = (order: MeasuredOrder): boolean => order.project === project;
  const sameKind = (order: MeasuredOrder): boolean => own(order) && order.kind === segment.kind;
  const sameCategory = (order: MeasuredOrder): boolean => sameKind(order) && order.category === segment.category;
  const sameSteps = (order: MeasuredOrder): boolean =>
    sameCategory(order) && stepClassOf(order.steps) === segment.stepClass;
  const levels: [SegmentScope, (order: MeasuredOrder) => boolean][] = [
    ['kindCategory', sameCategory],
    ['kind', sameKind],
    ['project', own],
    ['all', () => true],
  ];
  if (segment.stepClass) levels.unshift(['segment', sameSteps]);
  const pickLevel = (metric: 'hourRatio' | 'tokenRatio'): { factor: number; samples: number; scope: SegmentScope } => {
    for (const [scope, matches] of levels) {
      const values = recentPerProject(usable.filter(matches))
        .map((order) => order[metric])
        .filter((value): value is number => value !== null && value > 0);
      if (values.length >= MIN_CALIBRATION_SAMPLES)
        return { factor: round(clamp(median(values))), samples: values.length, scope };
    }
    return { factor: 1, samples: 0, scope: 'default' };
  };
  const hours = pickLevel('hourRatio');
  const tokens = pickLevel('tokenRatio');
  return {
    hours: hours.factor,
    tokens: tokens.factor,
    samples: hours.samples,
    scope: hours.scope,
    tokenSamples: tokens.samples,
    tokenScope: tokens.scope,
  };
}

/** Faktor einer Gruppe direkt aus der Datenbank (ein Abschluss wirkt sofort, es gibt nichts zu speichern). */
export async function loadSegmentFactor(
  pool: Pick<Pool, 'query'>,
  project: string,
  segment: Segment,
  sources: readonly EstimateSource[] = ESTIMATE_SOURCES,
): Promise<SegmentFactor> {
  return segmentFactorFrom(await loadMeasuredOrders(pool), project, segment, sources);
}

/** Herkünfte, aus denen der Auftragsautor lernt: der Altbestand (Menschenstunden) zählt nicht. */
export const AUTHOR_PROMPT_SOURCES: readonly EstimateSource[] = ESTIMATE_SOURCES.filter(
  (source) => source !== 'legacy',
);

/** Lesbarer Name der gewählten Stufe, z. B. „Feature · Kategorie backend · bis 10 Schritte (dieses Projekt)“. */
export function segmentScopeLabel(segment: Segment, scope: SegmentScope): string {
  const kind = ORDER_KIND_LABELS[segment.kind];
  const category = segment.category ? `Kategorie ${segment.category}` : 'ohne Kategorie';
  switch (scope) {
    case 'segment':
      return `${kind} · ${category} · ${STEP_CLASS_LABELS[segment.stepClass ?? 'small']} (dieses Projekt)`;
    case 'kindCategory':
      return `${kind} · ${category} (dieses Projekt)`;
    case 'kind':
      return `${kind} (dieses Projekt)`;
    case 'project':
      return 'alle Aufträge dieses Projekts';
    case 'all':
      return 'alle Aufträge aller Projekte';
    default:
      return 'Standard (zu wenige Messwerte)';
  }
}

/** Laufender Auftrag mit Schätzung und bisherigem Verbrauch (alle Läufe, alle Schritte und Rollen). */
export interface RunningOrder {
  id: string;
  title: string;
  status: string;
  kind: string;
  category: string | null;
  effortHours: number | null;
  tokenEstimate: number | null;
  estimateSource: string | null;
  steps: number;
  hours: number;
  tokens: number;
}

/** Warnung im Dashboard: Verbrauch über `OVERRUN_FACTOR` × kalibrierte Schätzung (Stunden oder Tokens). */
export interface EstimateOverrun {
  id: string;
  title: string;
  status: string;
  actual: { hours: number; tokens: number };
  calibrated: { hours: number | null; tokens: number | null };
  /** Ist ÷ kalibrierte Schätzung; null ohne brauchbare Schätzung. */
  ratio: { hours: number | null; tokens: number | null };
  exceeded: { hours: boolean; tokens: boolean };
  /** Gewählte Stufe der Kalibrierung (Stunden). */
  scope: SegmentScope;
}

/**
 * Laufende Aufträge (in Arbeit oder blockiert, also noch nicht abgeschlossen) mit ihrem Verbrauch. Gezählt werden
 * alle Schritte aller Läufe unabhängig vom Status – auch ein Auftrag, der ohne fehlgeschlagenen Schritt hängt.
 */
export const RUNNING_ORDERS_SQL = `
  SELECT d.id, d.title, d.status, d.kind, d.category, d.effort_hours AS "effortHours",
         d.token_estimate AS "tokenEstimate", d.estimate_source AS "estimateSource",
         COUNT(st.id) AS steps, COALESCE(SUM(st.duration_ms), 0) / 3600000.0 AS hours,
         COALESCE(SUM(st.tokens), 0) AS tokens
    FROM development_items d
    LEFT JOIN agent_runs r ON r.development_id = d.id
    LEFT JOIN agent_run_steps st ON st.run_id = r.id
   WHERE d.project_slug = $1 AND d.status IN ('${DEVELOPMENT_STATUS.inProgress}', '${DEVELOPMENT_STATUS.blocked}')
     AND d.kind <> 'express'
   GROUP BY d.id`;

/**
 * Überschrittene laufende Aufträge. Verglichen wird mit der kalibrierten Schätzung (Faktor der Gruppe für die
 * eigene Herkunft, also derselbe Massstab wie beim Modell-Routing), nicht mit der rohen. Ohne Schätzung oder bei
 * Schätzung 0 gibt es keine Warnung.
 */
export function overrunsFrom(running: RunningOrder[], measured: MeasuredOrder[], project: string): EstimateOverrun[] {
  const overruns: EstimateOverrun[] = [];
  for (const order of running) {
    const segment: Segment = {
      kind: kindOf(order.kind),
      category: order.category ?? null,
      stepClass: stepClassOf(order.steps),
    };
    const factor = segmentFactorFrom(measured, project, segment, [sourceOf(order.estimateSource)]);
    const calibrated = {
      hours: order.effortHours === null ? null : Math.round(order.effortHours * factor.hours * 100) / 100,
      tokens: order.tokenEstimate === null ? null : Math.round(order.tokenEstimate * factor.tokens),
    };
    const exceeded = {
      hours: exceedsEstimate(order.hours, calibrated.hours),
      tokens: exceedsEstimate(order.tokens, calibrated.tokens),
    };
    if (!exceeded.hours && !exceeded.tokens) continue;
    overruns.push({
      id: order.id,
      title: order.title,
      status: order.status,
      actual: { hours: Math.round(order.hours * 100) / 100, tokens: order.tokens },
      calibrated,
      ratio: {
        hours: overrunRatio(order.hours, calibrated.hours),
        tokens: overrunRatio(order.tokens, calibrated.tokens),
      },
      exceeded,
      scope: factor.scope,
    });
  }
  return overruns.sort(
    (a, b) => Math.max(b.ratio.hours ?? 0, b.ratio.tokens ?? 0) - Math.max(a.ratio.hours ?? 0, a.ratio.tokens ?? 0),
  );
}

const numberOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/** Warnliste des Projekts (der Aufrufer fängt Fehler ab: die Warnung blockiert nie etwas). */
export async function loadEstimateOverruns(pool: Pick<Pool, 'query'>, project: string): Promise<EstimateOverrun[]> {
  const running = (await pool.query<Record<keyof RunningOrder, unknown>>(RUNNING_ORDERS_SQL, [project])).rows.map(
    (row): RunningOrder => ({
      id: String(row.id),
      title: String(row.title ?? ''),
      status: String(row.status ?? ''),
      kind: String(row.kind ?? 'feature'),
      category: (row.category as string | null) ?? null,
      effortHours: numberOrNull(row.effortHours),
      tokenEstimate: numberOrNull(row.tokenEstimate),
      estimateSource: (row.estimateSource as string | null) ?? null,
      steps: Number(row.steps) || 0,
      hours: Number(row.hours) || 0,
      tokens: Number(row.tokens) || 0,
    }),
  );
  if (!running.length) return [];
  return overrunsFrom(running, await loadMeasuredOrders(pool), project);
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
