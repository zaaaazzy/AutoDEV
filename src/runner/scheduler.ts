import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { completeSprint } from '../api/sprint-planning.js';
import { type PushAudience, type PushMessage, sendPush } from '../core/push.js';
import { sprintSettled } from './sprint-autopilot.js';
import { type AlertLabels, BACKUP_FILE, collectProblems, evaluate, type WatchdogState } from './watchdog.js';

/**
 * Zeitgesteuerte Wartungs-Jobs: Der Worker prüft in seinem Arbeitszyklus die Tabelle scheduled_jobs, beansprucht
 * fällige aktive Jobs (eine Zeile nur für einen Worker) und führt sie mit hartem Zeitlimit aus. Ausgeführt wird nur,
 * was in der festen Registry steht – keine Pfade, Skripte oder Befehle aus der Datenbank.
 */
export type JobStatus = 'running' | 'ok' | 'warning' | 'failed';

export interface ScheduledJob {
  key: string;
  kind: string;
  config: Record<string, unknown>;
  intervalSeconds: number;
  state: Record<string, unknown>;
  /** Status vor dieser Beanspruchung (für die Meldung beim Übergang in „fehlgeschlagen“). */
  previousStatus: JobStatus | null;
}

export interface JobResult {
  status: Exclude<JobStatus, 'running'>;
  message: string;
  /** Neuer Merkzustand des Jobs (z. B. bereits gemeldete Probleme); undefined = unverändert. */
  state?: Record<string, unknown>;
}

/** Abhängigkeiten nach aussen, in Tests austauschbar. */
export interface SchedulerDeps {
  /** AIdeation-Ordner: relative Pfade der Job-Konfiguration gelten nur darin. */
  installRoot: string;
  push?: (pool: Pool, message: PushMessage, audience?: PushAudience) => Promise<number>;
  completeSprint?: (pool: Pool, sprintId: string) => Promise<void>;
  collectProblems?: typeof collectProblems;
  /** Inhaltsverzeichnis eines Dumps (pg_restore --list); Fehler mit code (ENOENT) bzw. stderr. */
  listDump?: (file: string, signal: AbortSignal) => Promise<string>;
  /** Restore-Probe (scripts/restore.sh --probe); liefert stdout, Fehler mit stderr. */
  restoreProbe?: (installRoot: string, file: string, signal: AbortSignal) => Promise<string>;
}

export interface JobContext {
  pool: Pool;
  job: ScheduledJob;
  deps: SchedulerDeps;
  signal: AbortSignal;
  now: Date;
}

export interface JobKind {
  run: (context: JobContext) => Promise<JobResult>;
  /** Zeitlimit ohne Angabe in der Konfiguration (timeoutSeconds). */
  defaultTimeoutSeconds: number;
}

/** Höchstens so viele Jobs je Zyklus und Worker. */
const CLAIM_BATCH = 10;
/** Obergrenze für timeoutSeconds aus der Konfiguration. */
export const MAX_TIMEOUT_SECONDS = 300;
/** Sperre eines beanspruchten Laufs: Zeitlimit plus Reserve; ein abgestürzter Worker gibt den Job danach frei. */
const LOCK_SECONDS = MAX_TIMEOUT_SECONDS + 30;
const MESSAGE_LIMIT = 2000;
const HOUR_MS = 3600_000;

const JOB_COLUMNS = `j.key, j.job_kind AS kind, j.config, j.interval_seconds AS "intervalSeconds", j.state`;

/** Nächster Termin im Raster ab next_run_at: immer in der Zukunft, auch wenn der Worker länger stand. */
export function nextRunAfter(nextRunAt: Date, intervalSeconds: number, now: Date): Date {
  const interval = intervalSeconds * 1000;
  const missed = Math.max(0, Math.floor((now.getTime() - nextRunAt.getTime()) / interval));
  return new Date(nextRunAt.getTime() + (missed + 1) * interval);
}

/** Fällig = aktiv, Termin erreicht und nicht von einem anderen Lauf gesperrt. */
export function isDue(job: { enabled: boolean; nextRunAt: Date; lockedUntil: Date | null }, now: Date): boolean {
  return job.enabled && job.nextRunAt <= now && (!job.lockedUntil || job.lockedUntil < now);
}

/**
 * Beansprucht fällige Jobs in einer Anweisung: SKIP LOCKED lässt gleichzeitig laufende Worker an der Zeile vorbei,
 * next_run_at und locked_until sind danach gesetzt – ein zweiter Worker findet den Job nicht mehr fällig.
 */
export async function claimDueJobs(pool: Pool, limit = CLAIM_BATCH): Promise<ScheduledJob[]> {
  return (
    await pool.query<ScheduledJob>(
      `UPDATE scheduled_jobs j
          SET next_run_at = j.next_run_at + make_interval(secs => (j.interval_seconds *
                (floor(EXTRACT(EPOCH FROM NOW() - j.next_run_at) / j.interval_seconds) + 1))::float8),
              locked_until = NOW() + make_interval(secs => $2),
              last_run_at = NOW(), last_status = 'running'
         FROM (SELECT key, last_status FROM scheduled_jobs
                WHERE enabled AND next_run_at <= NOW() AND (locked_until IS NULL OR locked_until < NOW())
                ORDER BY next_run_at LIMIT $1 FOR UPDATE SKIP LOCKED) due
        WHERE j.key = due.key
        RETURNING ${JOB_COLUMNS}, due.last_status AS "previousStatus"`,
      [limit, LOCK_SECONDS],
    )
  ).rows;
}

/** Schreibt das Ergebnis eines Laufs zurück und gibt die Sperre frei. */
async function finishJob(pool: Pool, key: string, result: JobResult): Promise<void> {
  await pool.query(
    `UPDATE scheduled_jobs SET last_status = $2, last_message = $3, state = COALESCE($4::jsonb, state),
            locked_until = NULL WHERE key = $1`,
    [key, result.status, result.message.slice(0, MESSAGE_LIMIT), result.state ? JSON.stringify(result.state) : null],
  );
}

/** Führt eine Aufgabe mit hartem Zeitlimit aus; danach wird sie abgebrochen (AbortSignal) und gilt als gescheitert. */
export async function runWithTimeout<T>(task: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Zeitlimit von ${Math.round(timeoutMs / 1000)} s erreicht.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([task(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Ganze Zahl aus der Konfiguration, auf den erlaubten Bereich begrenzt. */
function numberSetting(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function textSetting(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Pfad aus der Konfiguration, nur innerhalb des AIdeation-Ordners (keine absoluten Pfade, kein „..“). */
export function insideRoot(root: string, path: string): string | null {
  if (isAbsolute(path)) return null;
  const full = resolve(root, path);
  const rel = relative(root, full);
  return rel.startsWith('..') || isAbsolute(rel) ? null : full;
}

const failed = (message: string): JobResult => ({ status: 'failed', message });

const execFileAsync = promisify(execFile);
const OUTPUT_LIMIT = 64 * 1024 * 1024;

/** pg_restore aus DEV_LOG_PG_RESTORE (Umgebung des Workers, nie aus der Datenbank), sonst aus dem PATH. */
async function pgRestoreList(file: string, signal: AbortSignal): Promise<string> {
  const program = process.env.DEV_LOG_PG_RESTORE?.trim() || 'pg_restore';
  return (await execFileAsync(program, ['--list', file], { signal, maxBuffer: OUTPUT_LIMIT })).stdout;
}

/** Fester Pfad im AIdeation-Ordner; mit bash aufgerufen, damit kein Ausführungsrecht nötig ist. */
async function runRestoreProbe(installRoot: string, file: string, signal: AbortSignal): Promise<string> {
  const script = join(installRoot, 'scripts', 'restore.sh');
  return (await execFileAsync('bash', [script, '--probe', file], { cwd: installRoot, signal, maxBuffer: OUTPUT_LIMIT }))
    .stdout;
}

/** Letzte nicht leere Zeile (Meldung eines Programms), gekürzt. */
function lastLine(text: unknown): string {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return (lines.at(-1) ?? '').slice(0, 400);
}

/** Fehler eines externen Programms als klare Meldung; ein fehlendes Programm ist nie ein stiller Erfolg. */
function toolFailure(tool: string, error: unknown, hint: string): string {
  const { code, stderr, message } = error as { code?: unknown; stderr?: unknown; message?: string };
  if (code === 'ENOENT') return `${tool} nicht gefunden – ${hint}`;
  return `${tool} gescheitert: ${lastLine(stderr) || message || String(error)}`;
}

interface BackupFile {
  name: string;
  path: string;
  mtimeMs: number;
  size: number;
}

/** Neuestes aideation-*.dump im konfigurierten Ordner oder ein Fehlerergebnis. */
async function newestBackup(job: ScheduledJob, deps: SchedulerDeps): Promise<BackupFile | JobResult> {
  const configured = textSetting(job.config.dir) ?? 'backups';
  const dir = insideRoot(deps.installRoot, configured);
  if (!dir) return failed(`Backup-Ordner „${configured}“ liegt ausserhalb des AIdeation-Ordners.`);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    // Im Worker ist der Ordner vielleicht nicht eingebunden: melden statt still aussetzen.
    const code = (error as { code?: string }).code ?? (error as Error).message;
    return failed(`Backup-Ordner „${configured}“ nicht erreichbar (${code}).`);
  }
  const dumps = await Promise.all(
    names.filter((name) => BACKUP_FILE.test(name)).map(async (name) => ({ name, info: await stat(join(dir, name)) })),
  );
  const newest = dumps.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)[0];
  if (!newest) return failed(`Kein Datenbank-Backup in „${configured}“.`);
  return { name: newest.name, path: join(dir, newest.name), mtimeMs: newest.info.mtimeMs, size: newest.info.size };
}

const PG_RESTORE_HINT =
  'ohne pg_restore lässt sich das Backup nicht prüfen. Postgres-Client ab Version 17 installieren ' +
  '(macOS: brew install libpq) oder DEV_LOG_PG_RESTORE in der worker.env auf das Programm setzen.';

/**
 * Neuestes Backup in ./backups: vorhanden, jünger als maxAgeHours, nicht kleiner als minBytes und für pg_restore
 * lesbar (pg_restore --list mit Tabellendaten). Ein fehlendes pg_restore ist ein Fehler, kein stiller Erfolg.
 */
async function backupCheck({ job, deps, signal }: JobContext): Promise<JobResult> {
  const newest = await newestBackup(job, deps);
  if ('status' in newest) return newest;
  const maxAgeHours = numberSetting(job.config.maxAgeHours, 26, 1, 24 * 30);
  const minBytes = numberSetting(job.config.minBytes, 1024, 0, 1024 ** 4);
  const ageHours = (Date.now() - newest.mtimeMs) / HOUR_MS;
  if (ageHours > maxAgeHours) {
    return failed(`Neuestes Backup ${newest.name} ist ${Math.round(ageHours)} h alt (Grenze ${maxAgeHours} h).`);
  }
  if (newest.size < minBytes) {
    return failed(`Neuestes Backup ${newest.name} ist mit ${newest.size} Bytes zu klein (mindestens ${minBytes}).`);
  }
  let toc: string;
  try {
    toc = await (deps.listDump ?? pgRestoreList)(newest.path, signal);
  } catch (error) {
    return failed(`Backup ${newest.name} nicht geprüft: ${toolFailure('pg_restore --list', error, PG_RESTORE_HINT)}`);
  }
  // Einträge: „123; 0 16386 TABLE DATA public projects devlog“; Kommentarzeilen beginnen mit „;“.
  const entries = toc.split('\n').filter((line) => /^\d+;/.test(line));
  if (!entries.some((line) => / TABLE DATA /.test(line))) {
    return failed(`Backup ${newest.name} enthält laut pg_restore --list keine Tabellendaten.`);
  }
  return {
    status: 'ok',
    message:
      `Neuestes Backup ${newest.name}: ${ageHours.toFixed(1)} h alt, ${Math.round(newest.size / 1024)} KB, ` +
      `${entries.length} Einträge für pg_restore lesbar.`,
  };
}

/**
 * Wöchentliche Restore-Probe: spielt das neueste Backup mit scripts/restore.sh --probe in einen Wegwerf-Container
 * (eigener Name und Port, nie die Live-Datenbank) und prüft DEV_LOG_SECRET_KEY per Entschlüsselungs-Test.
 */
async function restoreProbe({ job, deps, signal }: JobContext): Promise<JobResult> {
  const newest = await newestBackup(job, deps);
  if ('status' in newest) return newest;
  try {
    const output = await (deps.restoreProbe ?? runRestoreProbe)(deps.installRoot, newest.path, signal);
    return { status: 'ok', message: lastLine(output) || `Restore-Probe mit ${newest.name} bestanden.` };
  } catch (error) {
    return failed(
      `Restore-Probe mit ${newest.name}: ${toolFailure('scripts/restore.sh', error, 'bash fehlt im PATH des Workers.')}`,
    );
  }
}

/** Gemerkte Meldungen im Format des Wächters aus scheduled_jobs.state. */
function alertState(state: Record<string, unknown>): WatchdogState {
  return {
    problems: Array.isArray(state.problems) ? state.problems.filter((entry) => typeof entry === 'string') : [],
    notifiedAt: typeof state.notifiedAt === 'number' ? state.notifiedAt : null,
  };
}

/** Nur http(s)-Adressen aus der Konfiguration. */
function httpUrl(value: unknown): string | null {
  const text = textSetting(value);
  return text && /^https?:\/\/[^\s]+$/.test(text) ? text.replace(/\/$/, '') : null;
}

/**
 * Wächter-Prüfungen im Worker (collectProblems ohne Git-Aufruf, keine Befehle über den PATH). evaluate entscheidet
 * wie beim Wächter: neue Probleme sofort, anhaltende erst nach REMIND_MS wieder, Erholung einmal. Der Merkzustand
 * liegt in der Datenbank, damit mehrere Worker dieselbe Meldung nicht doppelt schicken.
 */
async function watchdogLogs({ pool, job, deps, now }: JobContext): Promise<JobResult> {
  const backupDir = insideRoot(deps.installRoot, textSetting(job.config.backupDir) ?? 'backups');
  const { problems } = await (deps.collectProblems ?? collectProblems)({
    pool,
    localUrl: httpUrl(job.config.localUrl) ?? process.env.DEV_LOG_LOCAL_URL ?? 'http://127.0.0.1:3100',
    publicUrl: httpUrl(job.config.publicUrl) ?? (process.env.DEV_LOG_PUBLIC_URL?.trim() || null),
    backupDir: backupDir ?? join(deps.installRoot, 'backups'),
    dataDir: deps.installRoot,
  });
  const { message, state } = evaluate(alertState(job.state), problems, now.getTime());
  if (message) await (deps.push ?? sendPush)(pool, message, {});
  return {
    status: problems.length ? 'warning' : 'ok',
    message: problems.length
      ? `${problems.length} Problem(e)${message ? ', gemeldet' : ', bereits gemeldet'}: ${problems.join(' | ')}`
      : 'Keine Probleme.',
    state: { problems: state.problems, notifiedAt: state.notifiedAt },
  };
}

const INACTIVE_DAYS_DEFAULT = 14;

/**
 * Schliesst laufende Sprints, die vollständig abgearbeitet (sprintSettled) und seit inactiveDays ohne Bewegung sind.
 * Pausierte Sprints und Sprints mit laufendem Agent bleiben offen; der Abschluss läuft über completeSprint wie in der
 * Oberfläche (Bericht, Git-Sicherung durch den Worker).
 */
async function closeOldSprints({ pool, job, deps, signal }: JobContext): Promise<JobResult> {
  const days = Math.round(numberSetting(job.config.inactiveDays, INACTIVE_DAYS_DEFAULT, 1, 365));
  const project = textSetting(job.config.project);
  const candidates = (
    await pool.query<{ id: string; project: string; name: string }>(
      `SELECT s.id, s.project_slug AS project, s.name FROM sprints s
        WHERE s.status = 'active' AND s.paused_at IS NULL AND ($2::text IS NULL OR s.project_slug = $2)
          AND GREATEST(s.updated_at,
                (SELECT MAX(d.updated_at) FROM development_items d WHERE d.sprint_id = s.id),
                (SELECT MAX(r.started_at) FROM agent_runs r JOIN development_items d ON d.id = r.development_id
                  WHERE d.sprint_id = s.id)) < NOW() - make_interval(days => $1)
          AND NOT EXISTS (SELECT 1 FROM agent_runs r JOIN development_items d ON d.id = r.development_id
                           WHERE d.sprint_id = s.id AND r.status = 'running')`,
      [days, project],
    )
  ).rows;
  const closed: string[] = [];
  for (const sprint of candidates) {
    if (signal.aborted) break;
    const items = (
      await pool.query<{ status: string; actionTodo: string | null; budgetBlocked: string | null }>(
        `SELECT status, action_todo AS "actionTodo", budget_blocked AS "budgetBlocked" FROM development_items
          WHERE sprint_id = $1 AND status <> 'rejected' AND kind <> 'express'`,
        [sprint.id],
      )
    ).rows;
    if (!sprintSettled(items)) continue;
    await (deps.completeSprint ?? completeSprint)(pool, sprint.id);
    closed.push(`${sprint.project}: ${sprint.name}`);
    await (deps.push ?? sendPush)(
      pool,
      {
        title: `🏁 Sprint abgeschlossen · ${sprint.project}`,
        body: `${sprint.name}: alle Aufträge erledigt, seit ${days} Tagen ohne Bewegung – automatisch abgeschlossen.`,
        url: `#sprints?project=${encodeURIComponent(sprint.project)}`,
        tag: `sprint-closed-${sprint.id}`,
      },
      { project: sprint.project },
    );
  }
  return {
    status: 'ok',
    message: closed.length
      ? `${closed.length} Sprint(s) abgeschlossen: ${closed.join(', ')}`
      : `Kein abgearbeiteter Sprint, der seit ${days} Tagen ruht.`,
  };
}

const ALERT_LABELS: AlertLabels = {
  fresh: '⚠ AIdeation: Wartungs-Job fehlgeschlagen',
  ongoing: '⚠ AIdeation: Wartungs-Job weiterhin fehlgeschlagen',
  recovered: '✓ AIdeation: Wartungs-Jobs wieder in Ordnung',
  recoveredBody: 'Alle beobachteten Wartungs-Jobs laufen wieder.',
  tag: 'scheduled-jobs',
  url: '#dashboard',
};

/**
 * Push, wenn ein beobachteter Job (config.jobs, sonst alle anderen) fehlgeschlagen ist – an den Projektkreis aus
 * config.project, sonst an die Administratoren. Gleiche Fehlschläge meldet evaluate erst nach REMIND_MS wieder.
 */
async function pushAlert({ pool, job, deps, now }: JobContext): Promise<JobResult> {
  const watched = Array.isArray(job.config.jobs)
    ? job.config.jobs.filter((entry): entry is string => typeof entry === 'string')
    : null;
  const rows = (
    await pool.query<{ key: string; status: string | null; message: string | null }>(
      `SELECT key, last_status AS status, last_message AS message FROM scheduled_jobs
        WHERE key <> $1 AND enabled AND job_kind <> 'push_alert' AND ($2::text[] IS NULL OR key = ANY($2))
        ORDER BY key`,
      [job.key, watched],
    )
  ).rows.filter((row) => row.status === 'failed');
  // Schlüssel ohne Zahlen: eine geänderte Stundenangabe gilt nicht als neues Problem.
  const problems = rows.map((row) => `Job „${row.key}“ fehlgeschlagen`);
  const { message, state } = evaluate(alertState(job.state), problems, now.getTime(), ALERT_LABELS);
  const project = textSetting(job.config.project);
  if (message) {
    const body = rows.length
      ? rows.map((row) => `${row.key}: ${row.message ?? 'ohne Meldung'}`).join('\n')
      : message.body;
    await (deps.push ?? sendPush)(pool, { ...message, body }, project ? { project } : {});
  }
  return {
    status: rows.length ? 'warning' : 'ok',
    message: rows.length
      ? `Kritisch: ${rows.map((row) => row.key).join(', ')}${message ? ' – Push gesendet.' : ' – bereits gemeldet.'}`
      : 'Alle beobachteten Jobs in Ordnung.',
    state: { problems: state.problems, notifiedAt: state.notifiedAt },
  };
}

/** Feste Registry: Nur diese Job-Arten werden ausgeführt (job_kind; „Skript-Pfad“ der Idee = Schlüssel hier). */
export const JOB_KINDS: Readonly<Record<string, JobKind>> = Object.freeze({
  backup_check: { run: backupCheck, defaultTimeoutSeconds: 60 },
  restore_probe: { run: restoreProbe, defaultTimeoutSeconds: MAX_TIMEOUT_SECONDS },
  watchdog_logs: { run: watchdogLogs, defaultTimeoutSeconds: 60 },
  close_old_sprints: { run: closeOldSprints, defaultTimeoutSeconds: 120 },
  push_alert: { run: pushAlert, defaultTimeoutSeconds: 20 },
});

/** Job-Art aus der Registry; Object.hasOwn, damit „constructor“ & Co. nie als Art gelten. */
export function jobKind(kind: string, registry: Readonly<Record<string, JobKind>> = JOB_KINDS): JobKind | null {
  return Object.hasOwn(registry, kind) ? registry[kind]! : null;
}

export function timeoutMs(job: ScheduledJob, kind: JobKind): number {
  return numberSetting(job.config.timeoutSeconds, kind.defaultTimeoutSeconds, 1, MAX_TIMEOUT_SECONDS) * 1000;
}

/** Führt einen beanspruchten Job aus; Fehler, Zeitlimit und unbekannte Art enden als Status, nie als Ausnahme. */
export async function runJob(
  pool: Pool,
  job: ScheduledJob,
  deps: SchedulerDeps,
  registry: Readonly<Record<string, JobKind>> = JOB_KINDS,
): Promise<JobResult> {
  const kind = jobKind(job.kind, registry);
  let result: JobResult;
  if (!kind) {
    result = failed(`Übersprungen: unbekannte Job-Art „${job.kind}“.`);
  } else {
    try {
      result = await runWithTimeout(
        (signal) => kind.run({ pool, job, deps, signal, now: new Date() }),
        timeoutMs(job, kind),
      );
    } catch (error) {
      result = failed(`Fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await finishJob(pool, job.key, result);
  return result;
}

/**
 * Nach einem Fehlschlag: push_alert-Jobs, die ihn beobachten, sofort fällig machen. Beobachtet keiner den Job,
 * geht beim Wechsel in „fehlgeschlagen“ direkt ein Push an die Administratoren.
 */
async function raiseAlerts(pool: Pool, failures: ScheduledJob[], deps: SchedulerDeps): Promise<void> {
  const keys = failures.map((job) => job.key);
  const woken = (
    await pool.query<{ key: string; jobs: string[] | null }>(
      `UPDATE scheduled_jobs SET next_run_at = LEAST(next_run_at, NOW())
        WHERE enabled AND job_kind = 'push_alert' AND key <> ALL($1::text[])
          AND (jsonb_typeof(config->'jobs') IS DISTINCT FROM 'array' OR config->'jobs' ?| $1::text[])
        RETURNING key, CASE WHEN jsonb_typeof(config->'jobs') = 'array'
          THEN ARRAY(SELECT jsonb_array_elements_text(config->'jobs')) END AS jobs`,
      [keys],
    )
  ).rows;
  for (const job of failures) {
    const watched = woken.some((alert) => !alert.jobs || alert.jobs.includes(job.key));
    if (watched || job.previousStatus === 'failed' || job.kind === 'push_alert') continue;
    await (deps.push ?? sendPush)(
      pool,
      {
        title: ALERT_LABELS.fresh,
        body: `Job „${job.key}“ ist fehlgeschlagen.`,
        url: ALERT_LABELS.url,
        tag: ALERT_LABELS.tag,
      },
      {},
    );
  }
}

export interface JobRun {
  key: string;
  status: JobResult['status'];
  message: string;
}

/**
 * Ein Durchgang im Worker-Zyklus: fällige Jobs beanspruchen und nacheinander ausführen. Ein Fehlschlag macht die
 * beobachtenden push_alert-Jobs fällig; die laufen im zweiten Durchgang gleich mit.
 */
export async function runDueJobs(
  pool: Pool,
  deps: SchedulerDeps,
  stopping: () => boolean = () => false,
  registry: Readonly<Record<string, JobKind>> = JOB_KINDS,
): Promise<JobRun[]> {
  const runs: JobRun[] = [];
  for (let pass = 0; pass < 2 && !stopping(); pass += 1) {
    const jobs = await claimDueJobs(pool);
    if (!jobs.length) break;
    const failures: ScheduledJob[] = [];
    for (const job of jobs) {
      const result = await runJob(pool, job, deps, registry);
      runs.push({ key: job.key, status: result.status, message: result.message });
      if (result.status === 'failed') failures.push(job);
    }
    if (!failures.length) break;
    await raiseAlerts(pool, failures, deps);
  }
  return runs;
}
