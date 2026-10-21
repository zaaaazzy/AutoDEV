import { isIP } from 'node:net';
import type { Pool } from 'pg';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { describeError } from '../core/log.js';
import { type PushMessage, sendPush } from '../core/push.js';
import { maskSecrets } from '../core/secret-mask.js';
import { errorFingerprint, isExcluded, type ProductionError, recordEvent } from './production-events.js';
import { agentEnvironment } from './runner-prompts.js';
import { type AlertLabels, evaluate, problemKey, type WatchdogState } from './watchdog.js';

/**
 * Sammler des Produktions-Rückkanals im Worker: Health-URL alle 2 Minuten, Compose-Logs alle 15 Minuten (lückenlos ab
 * dem letzten erfolgreichen Scan) und direkt nach jedem erfolgreichen Deploy, Aufbewahrung stündlich. Meldungen folgen dem Wächter (neu sofort, anhaltend alle
 * 6 Stunden, Erholung einmal).
 */
export const HEALTH_INTERVAL_MS = 2 * 60_000;
export const LOG_INTERVAL_MS = 15 * 60_000;
const PURGE_INTERVAL_MS = 60 * 60_000;
const HEALTH_TIMEOUT_MS = 10_000;
const LOG_TIMEOUT_MS = 60_000;
export const HEALTH_TITLE = 'Anwendung nicht erreichbar';
export const SERVICE_NAME = /^[A-Za-z0-9][\w.-]{0,62}$/;

// ── Health-URL ────────────────────────────────────────────────────────────────────────────────────────────────

const LAN_SUFFIXES = ['.local', '.lan', '.home.arpa', '.internal', '.localhost'];

function isPrivateIp(host: string): boolean {
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number) as [number, number];
    // Kein 0.0.0.0/8 und kein 169.254/16 (Link-Local, dort liegen Metadaten-Dienste von Cloud-Servern).
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (isIP(host) === 6) {
    const lower = host.toLowerCase();
    return lower === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(lower) || /^fe[89ab][0-9a-f]?:/.test(lower);
  }
  return false;
}

/** Eigene Domains: DEV_LOG_DOMAIN und DEV_LOG_OWN_DOMAINS (Komma-getrennt), jeweils samt Subdomains. */
export function ownDomains(environment: NodeJS.ProcessEnv = process.env): string[] {
  return [environment.DEV_LOG_DOMAIN ?? '', ...(environment.DEV_LOG_OWN_DOMAINS ?? '').split(',')]
    .map((domain) =>
      domain
        .trim()
        .toLowerCase()
        .replace(/^\*?\./, ''),
    )
    .filter((domain) => domain.includes('.') && !isIP(domain));
}

/** Nur http(s) auf localhost, ein Gerät im lokalen Netz oder eine eigene Domain; keine Zugangsdaten in der URL. */
export function healthUrlError(value: unknown, environment: NodeJS.ProcessEnv = process.env): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  let url: URL;
  try {
    if (!text || text.length > 500) throw new Error('length');
    url = new URL(text);
  } catch {
    return 'Ungültige Health-URL, z. B. http://localhost:8080/health.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Health-URL: nur http:// oder https:// erlaubt.';
  if (url.username || url.password) return 'Health-URL: bitte keine Zugangsdaten in der URL.';
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const local =
    host === 'localhost' ||
    host === 'host.docker.internal' ||
    LAN_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    (!host.includes('.') && !host.includes(':')) ||
    isPrivateIp(host);
  const own = ownDomains(environment).some((domain) => host === domain || host.endsWith(`.${domain}`));
  return local || own
    ? null
    : 'Health-URL muss auf localhost, ein Gerät im lokalen Netz oder eine eigene Domain zeigen (DEV_LOG_DOMAIN bzw. DEV_LOG_OWN_DOMAINS).';
}

export interface HealthState {
  failures: number;
  down: boolean;
}

/** Zwei Fehlschläge in Folge gelten als Ausfall; ein einzelner nicht. Erfolg nach Ausfall = Erholung. */
export function nextHealth(state: HealthState, ok: boolean): HealthState & { change: 'down' | 'recovered' | null } {
  if (ok) return { failures: 0, down: false, change: state.down ? 'recovered' : null };
  const failures = state.failures + 1;
  const down = failures >= 2;
  return { failures, down, change: down && !state.down ? 'down' : null };
}

export type Fetcher = (url: string, init: RequestInit) => Promise<{ status: number }>;

/** Prüft die URL; null = erreichbar (2xx/3xx, Weiterleitungen werden nicht verfolgt), sonst der Grund. */
export async function probe(url: string, fetcher: Fetcher = fetch): Promise<string | null> {
  try {
    const response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return response.status >= 200 && response.status < 400 ? null : `antwortet mit ${response.status}`;
  } catch (error) {
    const cause = (error as Error).cause;
    return (cause instanceof Error ? cause.message : (error as Error).message).slice(0, 200);
  }
}

/** Ein Health-Durchgang: Zustand fortschreiben, beim Ausfall (und solange er anhält) ein Ereignis erfassen. */
export async function checkHealth(
  pool: Pool,
  project: string,
  fetcher: Fetcher = fetch,
  now = new Date(),
): Promise<HealthState & { change: 'down' | 'recovered' | null }> {
  const row = (
    await pool.query<{ url: string | null; failures: number | null; down: boolean | null }>(
      `SELECT p.health_url AS url, s.failures, s.down
         FROM projects p LEFT JOIN production_status s ON s.project_slug = p.slug WHERE p.slug = $1`,
      [project],
    )
  ).rows[0];
  const previous = { failures: row?.failures ?? 0, down: row?.down ?? false };
  if (!row?.url) {
    if (previous.down || previous.failures) {
      await pool.query(
        `UPDATE production_status SET failures = 0, down = FALSE, down_since = NULL WHERE project_slug = $1`,
        [project],
      );
    }
    return { failures: 0, down: false, change: previous.down ? 'recovered' : null };
  }
  const failure = await probe(row.url, fetcher);
  const next = nextHealth(previous, failure === null);
  await pool.query(
    `INSERT INTO production_status (project_slug, failures, down, last_error, checked_at, down_since)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $3 THEN $5::timestamptz END)
     ON CONFLICT (project_slug) DO UPDATE
       SET failures = $2, down = $3, last_error = $4, checked_at = $5,
           down_since = CASE WHEN NOT $3 THEN NULL ELSE COALESCE(production_status.down_since, $5::timestamptz) END`,
    [project, next.failures, next.down, failure, now],
  );
  if (next.down) {
    await recordEvent(
      pool,
      project,
      {
        source: 'health',
        title: HEALTH_TITLE,
        message: HEALTH_TITLE,
        detail: `Health-URL ${row.url}: ${failure ?? 'keine Antwort'}`,
        origin: 'health',
        // Beim Ausfall zählen beide Fehlschläge, danach jeder weitere.
        count: next.change === 'down' ? next.failures : 1,
        critical: true,
      },
      now,
    );
  }
  return next;
}

// ── Compose-Logs ──────────────────────────────────────────────────────────────────────────────────────────────

const COMPOSE_PREFIX = /^([A-Za-z0-9][\w.-]*?)(?:[-_]\d+)?\s+\|\s?(.*)$/;
const ERROR_LINE =
  /\b(?:ERROR|FATAL|CRITICAL|PANIC)\b|\blevel["']?\s*[=:]\s*["']?(?:error|fatal|critical)\b|\b(?:Uncaught|Unhandled)\b|\b(?:[A-Z][A-Za-z]*)?(?:Error|Exception)\b(?::|$)/;
const HTTP_5XX =
  /HTTP\/\d(?:\.\d)?"?\s+5\d\d\b|\bstatus(?:Code)?["']?\s*[=:]\s*["']?5\d\d\b|\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+\s+5\d\d\b/;
const JS_FRAME = /^\s+at\s+\S/;
const PY_FRAME = /^\s+File "[^"]+", line \d+/;
const TRACEBACK = /^Traceback \(most recent call last\):/;
const PY_EXCEPTION = /^[A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Warning)\b/;
const MAX_FRAMES = 20;

interface OpenError {
  service: string;
  message: string;
  frames: string[];
  python: boolean;
}

/** Erkennt Stacktraces, ERROR-Zeilen und HTTP-5xx in `docker compose logs` und bündelt gleiche Fehler mit Anzahl. */
export function parseComposeLogs(output: string, ignore: readonly string[] = []): ProductionError[] {
  const open = new Map<string, OpenError>();
  const found: ProductionError[] = [];
  const finish = (service: string): void => {
    const error = open.get(service);
    open.delete(service);
    if (!error) return;
    const stack = error.frames.join('\n');
    const message = error.message || 'Traceback';
    if (isExcluded(`${message}\n${stack}`, ignore)) return;
    found.push({ source: 'logs', message, stack, origin: error.service });
  };
  for (const raw of output.split(/\r?\n/)) {
    const prefixed = raw.match(COMPOSE_PREFIX);
    const service = prefixed?.[1] ?? '';
    const text = prefixed ? prefixed[2]! : raw;
    if (!text.trim()) continue;
    const current = open.get(service);
    if (current?.python) {
      // Eingerückt: Frame („File …, line …“) oder die Codezeile darunter.
      if (/^\s/.test(text)) {
        if (PY_FRAME.test(text) && current.frames.length < MAX_FRAMES) current.frames.push(text.trim());
        continue;
      }
      if (PY_EXCEPTION.test(text.trim())) {
        current.message = text.trim();
        finish(service);
        continue;
      }
    }
    if (current && !current.python && JS_FRAME.test(text)) {
      if (current.frames.length < MAX_FRAMES) current.frames.push(text.trim());
      continue;
    }
    finish(service);
    if (isExcluded(text, ignore)) continue;
    if (TRACEBACK.test(text.trim())) open.set(service, { service, message: '', frames: [], python: true });
    else if (ERROR_LINE.test(text) || HTTP_5XX.test(text))
      open.set(service, { service, message: text.trim(), frames: [], python: false });
  }
  for (const service of [...open.keys()]) finish(service);
  return found;
}

/** Längstes Fenster eines Log-Scans: ein verspäteter Tick wird ganz nachgeholt, längere Lücken werden vermerkt. */
export const LOG_MAX_WINDOW_MS = 4 * LOG_INTERVAL_MS;

export interface LogWindow {
  /** Untere Grenze (exklusiv): Zeilen mit Zeitstempel ≤ since hat ein früherer Scan schon gezählt. */
  since: Date;
  /** Hinweis auf nicht gelesene Zeilen, wenn der letzte erfolgreiche Scan zu lange her ist. */
  gap: string | null;
}

const utc = (date: Date): string => `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** Fenster seit dem letzten erfolgreichen Scan; beim ersten Scan das Standardintervall, höchstens LOG_MAX_WINDOW_MS. */
export function logWindow(scannedAt: Date | null, now: Date): LogWindow {
  if (!scannedAt) return { since: new Date(now.getTime() - LOG_INTERVAL_MS), gap: null };
  const earliest = new Date(now.getTime() - LOG_MAX_WINDOW_MS);
  if (scannedAt >= earliest) return { since: new Date(Math.min(scannedAt.getTime(), now.getTime())), gap: null };
  return {
    since: earliest,
    gap: `Logs von ${utc(scannedAt)} bis ${utc(earliest)} nicht gelesen (letzter erfolgreicher Scan zu lange her).`,
  };
}

const LOG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:[.,](\d+))?(Z|[+-]\d{2}:?\d{2})\s?/;

/** Zeitstempel von `--timestamps` (RFC 3339, auch Nanosekunden und Offsets) auf Millisekunden; null = keiner. */
export function logTimestamp(text: string): { at: number; length: number } | null {
  const match = LOG_TIMESTAMP.exec(text);
  if (!match) return null;
  const zone = match[3] === 'Z' ? 'Z' : `${match[3]!.slice(0, 3)}:${match[3]!.slice(-2)}`;
  const at = Date.parse(`${match[1]}.${(match[2] ?? '').padEnd(3, '0').slice(0, 3)}${zone}`);
  return Number.isNaN(at) ? null : { at, length: match[0].length };
}

/**
 * Behält nur Zeilen im Fenster (since, until] und entfernt den Zeitstempel. Beide Grenzen sind millisekundengenau wie
 * der gespeicherte Scan-Zeitpunkt, daher zählt jede Zeile in genau einem Scan. Zeilen ohne Zeitstempel folgen der
 * vorigen Zeile desselben Dienstes.
 */
export function linesInWindow(output: string, since: Date, until: Date): string {
  const inside = new Map<string, boolean>();
  const kept: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const prefixed = raw.match(COMPOSE_PREFIX);
    const service = prefixed?.[1] ?? '';
    const text = prefixed ? prefixed[2]! : raw;
    const prefix = raw.slice(0, raw.length - text.length);
    const stamp = logTimestamp(text);
    if (stamp) inside.set(service, stamp.at > since.getTime() && stamp.at <= until.getTime());
    if (inside.get(service) ?? true) kept.push(prefix + (stamp ? text.slice(stamp.length) : text));
  }
  return kept.join('\n');
}

/** Läuft je Projekt nacheinander: Scan nach dem Deploy und periodischer Scan dürfen dasselbe Fenster nicht doppelt lesen. */
const runningScans = new Map<string, Promise<unknown>>();

/**
 * Ein Log-Scan: Zeilen seit dem letzten erfolgreichen Scan holen, Ausschlussmuster anwenden, nach Fingerabdruck
 * gruppieren und als Ereignisse erfassen. Gleiche Logik für den Takt im Worker und den Scan nach dem Deploy.
 */
export function scanLogs(
  pool: Pool,
  project: string,
  cwd: string,
  execute: CommandExecutor = runCommand,
  now?: Date,
): Promise<{ events: number; occurrences: number } | null> {
  const previous = runningScans.get(project) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => scanOnce(pool, project, cwd, execute, now ?? new Date()));
  runningScans.set(project, run);
  const done = () => {
    if (runningScans.get(project) === run) runningScans.delete(project);
  };
  run.then(done, done);
  return run;
}

async function scanOnce(
  pool: Pool,
  project: string,
  cwd: string,
  execute: CommandExecutor,
  now: Date,
): Promise<{ events: number; occurrences: number } | null> {
  const row = (
    await pool.query<{ services: string[]; ignore: string[]; scannedAt: Date | null }>(
      `SELECT p.log_services AS services, p.production_ignore AS ignore, s.logs_scanned_at AS "scannedAt"
         FROM projects p LEFT JOIN production_status s ON s.project_slug = p.slug WHERE p.slug = $1`,
      [project],
    )
  ).rows[0];
  // Nur gültige Dienstnamen (kein führendes „-“, keine Leer- oder Sonderzeichen); der Befehl läuft ohne Shell.
  const services = (row?.services ?? []).filter((service) => SERVICE_NAME.test(service));
  if (!services.length) return null;
  const window = logWindow(row?.scannedAt ? new Date(row.scannedAt) : null, now);
  const command = [
    'docker',
    'compose',
    'logs',
    '--timestamps',
    '--since',
    window.since.toISOString(),
    '--no-color',
    ...services,
  ];
  const result = await execute(command, cwd, { timeoutMs: LOG_TIMEOUT_MS, env: agentEnvironment() }).catch(
    (error: unknown) => ({
      exitCode: 1,
      durationMs: 0,
      output: error instanceof Error ? error.message : String(error),
    }),
  );
  // Ohne Fehler rückt der Zeitstempel vor; mit Fehler bleibt er, damit der nächste Scan die Zeilen erneut liest.
  // Eine Lücke bleibt vermerkt, bis eine neue entsteht.
  const saveScan = (failed: string | null) =>
    pool.query(
      `INSERT INTO production_status (project_slug, logs_scanned_at, log_error, log_gap)
       VALUES ($1, CASE WHEN $3::text IS NULL THEN $2::timestamptz END, $3, $4)
       ON CONFLICT (project_slug) DO UPDATE
         SET logs_scanned_at = CASE WHEN $3::text IS NULL THEN $2 ELSE production_status.logs_scanned_at END,
             log_error = $3, log_gap = COALESCE($4, production_status.log_gap)`,
      [project, now, failed === null ? null : maskSecrets(failed).slice(0, 300), failed === null ? window.gap : null],
    );
  if (result.exitCode !== 0) {
    await saveScan(result.output.trim().split('\n').slice(-2).join(' ') || `Exit-Code ${result.exitCode}`);
    return null;
  }
  const grouped = new Map<string, ProductionError & { count: number }>();
  for (const error of parseComposeLogs(linesInWindow(result.output, window.since, now), row?.ignore ?? [])) {
    const key = errorFingerprint(error);
    const entry = grouped.get(key);
    if (entry) entry.count += 1;
    else grouped.set(key, { ...error, count: 1 });
  }
  let occurrences = 0;
  let failure: unknown = null;
  for (const error of grouped.values()) {
    // Ein gescheitertes Ereignis darf die übrigen dieses Durchgangs nicht verwerfen.
    try {
      await recordEvent(pool, project, error, now);
      occurrences += error.count;
    } catch (caught) {
      failure ??= caught;
    }
  }
  // Erst nach der Verarbeitung vorrücken: sonst wären nicht gespeicherte Fehler endgültig verloren.
  const message = failure instanceof Error ? failure.message : failure === null ? null : String(failure);
  await saveScan(message === null ? null : `Verarbeitung: ${message}`);
  if (grouped.size) await updateAlerts(pool, project, now);
  if (failure !== null) throw failure;
  return { events: grouped.size, occurrences };
}

// ── Meldungen ─────────────────────────────────────────────────────────────────────────────────────────────────

function alertLabels(name: string): AlertLabels {
  return {
    fresh: `⚠ ${name}: Fehler im Betrieb`,
    ongoing: `⚠ ${name}: Fehler im Betrieb besteht weiterhin`,
    recovered: `✓ ${name}: Entwarnung`,
    recoveredBody: 'Die Anwendung ist erreichbar, es treten keine kritischen Fehler mehr auf.',
    tag: `production-${name}`,
    url: '#bugs',
  };
}

/** Wie der Wächter; zusätzlich Entwarnung für einzelne erledigte Probleme, während andere noch bestehen. */
export function evaluateAlerts(
  previous: WatchdogState,
  problems: string[],
  now: number,
  name: string,
): { message: PushMessage | null; state: WatchdogState } {
  const labels = alertLabels(name);
  const result = evaluate(previous, problems, now, labels);
  if (result.message || !problems.length) return result;
  const current = new Set(problems.map(problemKey));
  const resolved = previous.problems.filter((problem) => !current.has(problemKey(problem)));
  if (!resolved.length) return result;
  return {
    message: {
      title: labels.recovered,
      body: `Behoben: ${resolved.join('\n')}\nWeiterhin: ${problems.join('\n')}`,
      url: labels.url,
      tag: labels.tag,
    },
    state: result.state,
  };
}

/** Aktuelle Probleme: Health-Ausfall und offene kritische Betriebs-Bugs, die in der letzten Stunde auftraten. */
export async function currentProblems(pool: Pool, project: string): Promise<string[]> {
  const problems: string[] = [];
  const status = (
    await pool.query<{ down: boolean; url: string | null }>(
      `SELECT s.down, p.health_url AS url FROM projects p LEFT JOIN production_status s ON s.project_slug = p.slug
        WHERE p.slug = $1`,
      [project],
    )
  ).rows[0];
  if (status?.down && status.url) problems.push(`${HEALTH_TITLE}: ${status.url}`);
  const critical = await pool.query<{ title: string }>(
    `SELECT b.title FROM bugs b
      WHERE b.project_slug = $1 AND b.source = 'production' AND b.severity = 'critical'
        AND b.status IN ('open', 'in_progress')
        AND EXISTS (SELECT 1 FROM production_events e WHERE e.bug_id = b.id AND e.source <> 'health'
                     AND e.last_seen > NOW() - INTERVAL '1 hour')
      ORDER BY b.created_at`,
    [project],
  );
  problems.push(...critical.rows.map((row) => `Kritischer Fehler: ${row.title}`));
  return problems;
}

/** Vergleicht mit dem gespeicherten Zustand und sendet bei Bedarf eine Push-Meldung an die Projekt-Geräte. */
export async function updateAlerts(
  pool: Pool,
  project: string,
  now = new Date(),
  notify: typeof sendPush = sendPush,
): Promise<PushMessage | null> {
  const problems = await currentProblems(pool, project);
  const row = (
    await pool.query<{ name: string; problems: string[] | null; notifiedAt: Date | null }>(
      `SELECT p.name, s.problems, s.notified_at AS "notifiedAt"
         FROM projects p LEFT JOIN production_status s ON s.project_slug = p.slug WHERE p.slug = $1`,
      [project],
    )
  ).rows[0];
  if (!row) return null;
  const previous: WatchdogState = {
    problems: row.problems ?? [],
    notifiedAt: row.notifiedAt ? new Date(row.notifiedAt).getTime() : null,
  };
  const { message, state } = evaluateAlerts(previous, problems, now.getTime(), row.name);
  await pool.query(
    `INSERT INTO production_status (project_slug, problems, notified_at) VALUES ($1, $2, $3)
     ON CONFLICT (project_slug) DO UPDATE SET problems = $2, notified_at = $3`,
    [project, state.problems, state.notifiedAt === null ? null : new Date(state.notifiedAt)],
  );
  if (message) await notify(pool, { ...message, url: `#bugs?project=${encodeURIComponent(project)}` }, { project });
  return message;
}

// ── Aufbewahrung und Zeitplan ─────────────────────────────────────────────────────────────────────────────────

/** Löscht Ereignisse, Verlauf und Deploys, die älter als die Aufbewahrung des Projekts sind. */
export async function purgeProductionData(pool: Pick<Pool, 'query'>): Promise<void> {
  await pool.query(
    `DELETE FROM production_events e USING projects p
      WHERE p.slug = e.project_slug AND e.last_seen < NOW() - make_interval(days => p.production_retention_days)`,
  );
  await pool.query(
    `DELETE FROM production_event_buckets b USING production_events e, projects p
      WHERE e.id = b.event_id AND p.slug = e.project_slug
        AND b.hour < NOW() - make_interval(days => p.production_retention_days)`,
  );
  await pool.query(
    `DELETE FROM production_deploys d USING projects p
      WHERE p.slug = d.project_slug AND d.deployed_at < NOW() - make_interval(days => p.production_retention_days)`,
  );
}

/** Zeitplan im Worker: jede Aufgabe je Projekt höchstens einmal gleichzeitig und im eigenen Takt. */
export class ProductionMonitor {
  private readonly lastRun = new Map<string, number>();
  private readonly active = new Set<string>();

  constructor(
    private readonly pool: Pool,
    private readonly execute: CommandExecutor = runCommand,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  tick(projects: { slug: string; cwd: string }[], now = Date.now()): void {
    for (const { slug, cwd } of projects) {
      this.schedule(`health:${slug}`, HEALTH_INTERVAL_MS, now, async () => {
        await checkHealth(this.pool, slug, this.fetcher);
        await updateAlerts(this.pool, slug);
      });
      this.schedule(`logs:${slug}`, LOG_INTERVAL_MS, now, () => scanLogs(this.pool, slug, cwd, this.execute));
    }
    this.schedule('purge', PURGE_INTERVAL_MS, now, () => purgeProductionData(this.pool));
  }

  private schedule(key: string, interval: number, now: number, task: () => Promise<unknown>): void {
    if (this.active.has(key) || now - (this.lastRun.get(key) ?? 0) < interval) return;
    this.lastRun.set(key, now);
    this.active.add(key);
    void task()
      .catch((error: unknown) => console.error(`Betriebs-Rückkanal (${key}) fehlgeschlagen:`, describeError(error)))
      .finally(() => this.active.delete(key));
  }
}
