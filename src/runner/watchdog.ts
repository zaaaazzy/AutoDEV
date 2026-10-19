import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, stat, statfs, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Pool } from 'pg';
import {
  deliverPush,
  loadSubscriptions,
  type PushMessage,
  type PushSubscriptionRow,
  vapidKeys,
  type VapidKeys,
} from '../core/push.js';

/**
 * Ausfall-Wächter: prüft alle paar Minuten Dienst, HTTPS-Zugang, Datenbank, Worker, Backups und Speicherplatz.
 * Meldet neue Probleme und die Erholung per Push. Schlüssel und Geräte werden lokal zwischengespeichert, damit die
 * Meldung auch dann rausgeht, wenn gerade die Datenbank ausgefallen ist.
 */
export interface WatchdogState {
  problems: string[];
  notifiedAt: number | null;
  keys?: VapidKeys;
  subscriptions?: PushSubscriptionRow[];
}

const REMIND_MS = 6 * 3600 * 1000;

/** Entscheidet, ob und was gemeldet wird: neue Probleme sofort, anhaltende alle 6 Stunden, Erholung einmal. */
export function evaluate(
  previous: WatchdogState,
  problems: string[],
  now = Date.now(),
): { message: PushMessage | null; state: WatchdogState } {
  const before = new Set(previous.problems);
  const fresh = problems.filter((problem) => !before.has(problem));
  const state: WatchdogState = { ...previous, problems };
  if (!problems.length) {
    if (!previous.problems.length) return { message: null, state };
    return {
      message: { title: '✓ Dev Log läuft wieder', body: 'Alle Prüfungen sind wieder in Ordnung.', tag: 'watchdog' },
      state: { ...state, notifiedAt: null },
    };
  }
  const remind = previous.notifiedAt !== null && now - previous.notifiedAt >= REMIND_MS;
  if (!fresh.length && !remind) return { message: null, state };
  return {
    message: {
      title: fresh.length ? '⚠ Dev Log: Problem erkannt' : '⚠ Dev Log: Problem besteht weiterhin',
      body: problems.join('\n'),
      url: '#dashboard',
      tag: 'watchdog',
    },
    state: { ...state, notifiedAt: now },
  };
}

async function reachable(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return response.ok ? null : `antwortet mit ${response.status}`;
  } catch (error) {
    return (error as Error).cause instanceof Error
      ? ((error as Error).cause as Error).message
      : (error as Error).message;
  }
}

export interface WatchdogOptions {
  pool: Pool;
  localUrl: string;
  publicUrl: string | null;
  backupDir: string;
  dataDir: string;
  /** Dev-Log-Ordner, aus dem der Worker seinen Code lädt (für die Prüfung auf nicht committete Änderungen). */
  installRoot?: string;
}

/** Ursache eines gescheiterten Agent-Schritts, grob eingeordnet (für die Meldung des Wächters). */
export function failureCause(output: string): string {
  if (/Laufwerk „[^“]+“ ist nicht verbunden|Arbeitsordner nicht erreichbar/.test(output)) return 'Laufwerk getrennt';
  if (/wurde im PATH des Workers nicht gefunden/.test(output)) return 'Befehl nicht gefunden';
  if (/wiederholt sich|wiederholt mit denselben Argumenten/.test(output)) return 'Wiederholungsschleife des Modells';
  if (/Zeitlimit erreicht|timeout or kill/i.test(output)) return 'Zeitlimit';
  if (/requires approval|nicht freigegeben|abgelehnt/i.test(output)) return 'fehlende Freigabe';
  if (/Ollama nicht erreichbar/.test(output)) return 'Ollama nicht erreichbar';
  return 'Fehler im Auftrag';
}

const FAILURE_WINDOW_HOURS = 6;
const MIN_FAILED_STEPS = 5;

/**
 * Häufen sich gescheiterte Agent-Schritte, steckt meist ein Umgebungsproblem dahinter (Laufwerk, PATH, Modell).
 * Liefert dann einen Satz mit der häufigsten Ursache – ohne Zahlen, damit er nicht bei jeder Prüfung neu meldet.
 */
export function failureProblem(steps: { status: string; output: string }[]): string | null {
  const failed = steps.filter((step) => step.status === 'failed');
  if (failed.length < MIN_FAILED_STEPS || failed.length * 2 < steps.length) return null;
  const counts = new Map<string, number>();
  for (const step of failed) counts.set(failureCause(step.output), (counts.get(failureCause(step.output)) ?? 0) + 1);
  const cause = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Fehler im Auftrag';
  return `Auffällig viele Agent-Schritte scheitern (mehr als die Hälfte in ${FAILURE_WINDOW_HOURS} h, meist: ${cause}).`;
}

/** Nicht committete Code-Änderungen im Dev-Log-Ordner: Der Worker lädt sie beim nächsten Neustart ungeprüft. */
async function uncommittedCode(installRoot: string): Promise<string | null> {
  const output = await new Promise<string>((resolve) => {
    execFile(
      'git',
      ['status', '--porcelain', '--', 'src', 'frontend/src', 'package.json', 'scripts'],
      { cwd: installRoot, timeout: 15_000 },
      (error, stdout) => resolve(error ? '' : stdout),
    );
  });
  return output.trim()
    ? 'Nicht committete Code-Änderungen im Dev-Log-Ordner – der Worker lädt sie beim nächsten Neustart ungeprüft. Committen oder auf einen Branch sichern.'
    : null;
}

/** Sammelt die aktuellen Probleme als kurze, lesbare Sätze. */
export async function collectProblems(options: WatchdogOptions): Promise<{ problems: string[]; dbOk: boolean }> {
  const problems: string[] = [];
  const local = await reachable(`${options.localUrl}/health`);
  if (local) problems.push(`Dev-Log-Dienst nicht erreichbar (${local}).`);
  if (options.publicUrl) {
    const remote = await reachable(`${options.publicUrl}/health`);
    if (remote) problems.push(`HTTPS-Zugang ${options.publicUrl} gestört (${remote}).`);
  }
  let dbOk = true;
  try {
    const heartbeat = await options.pool.query<{ age: number | null }>(
      `SELECT EXTRACT(EPOCH FROM NOW() - MAX(last_seen))::float AS age FROM worker_heartbeats`,
    );
    const age = heartbeat.rows[0]?.age;
    if (age !== null && age !== undefined && age > 5 * 60) {
      problems.push(`Worker meldet sich seit ${Math.round(age / 60)} Minuten nicht.`);
    }
  } catch (error) {
    dbOk = false;
    problems.push(`Datenbank nicht erreichbar (${(error as Error).message}).`);
  }
  if (dbOk) {
    const steps = await options.pool
      .query<{ status: string; output: string }>(
        `SELECT st.status, right(COALESCE(st.output, ''), 2000) AS output
           FROM agent_run_steps st JOIN agent_runs r ON r.id = st.run_id
          WHERE r.started_at > NOW() - make_interval(hours => $1) AND st.status IN ('passed', 'failed')`,
        [FAILURE_WINDOW_HOURS],
      )
      .catch(() => ({ rows: [] }));
    const failures = failureProblem(steps.rows);
    if (failures) problems.push(failures);
  }
  if (options.installRoot) {
    const dirty = await uncommittedCode(options.installRoot);
    if (dirty) problems.push(dirty);
  }
  const backups = await readdir(options.backupDir).catch(() => [] as string[]);
  const dumps = backups.filter((name) => /^dev_log-.*\.dump$/.test(name));
  const newest = (
    await Promise.all(dumps.map(async (name) => (await stat(join(options.backupDir, name))).mtimeMs))
  ).reduce((max, value) => Math.max(max, value), 0);
  if (!newest) problems.push('Noch kein automatisches Datenbank-Backup vorhanden.');
  else if (Date.now() - newest > 26 * 3600 * 1000) {
    problems.push(`Letztes Datenbank-Backup ist ${Math.round((Date.now() - newest) / 3600_000)} Stunden alt.`);
  }
  const disk = await statfs(options.dataDir).catch(() => null);
  if (disk) {
    const freeGb = (disk.bavail * disk.bsize) / 1024 ** 3;
    if (freeGb < 5) problems.push(`Nur noch ${freeGb.toFixed(1)} GB frei auf dem Projektlaufwerk.`);
  }
  return { problems, dbOk };
}

export function stateFile(): string {
  return join(homedir(), 'Library', 'Application Support', 'DevLog', 'watchdog.json');
}

export async function readState(file = stateFile()): Promise<WatchdogState> {
  try {
    return { problems: [], notifiedAt: null, ...(JSON.parse(await readFile(file, 'utf8')) as Partial<WatchdogState>) };
  } catch {
    return { problems: [], notifiedAt: null };
  }
}

export async function writeState(state: WatchdogState, file = stateFile()): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/** Ein Durchlauf: prüfen, Zustand vergleichen, ggf. melden, Zustand speichern. */
export async function runWatchdog(options: WatchdogOptions, file = stateFile()): Promise<WatchdogState> {
  const previous = await readState(file);
  const { problems, dbOk } = await collectProblems(options);
  const cached: Pick<WatchdogState, 'keys' | 'subscriptions'> = {};
  if (dbOk) {
    cached.keys = await vapidKeys(options.pool).catch(() => previous.keys);
    cached.subscriptions = await loadSubscriptions(options.pool).catch(() => previous.subscriptions);
  }
  const { message, state } = evaluate({ ...previous, ...cached }, problems);
  const keys = state.keys;
  const subscriptions = state.subscriptions ?? [];
  if (message && keys && subscriptions.length) {
    const { gone } = await deliverPush(keys, subscriptions, message);
    if (gone.length && dbOk) {
      await options.pool
        .query('DELETE FROM push_subscriptions WHERE endpoint = ANY($1)', [gone])
        .catch(() => undefined);
    }
  }
  if (message) console.info(`${new Date().toISOString()} ${message.title}: ${message.body.replace(/\n/g, ' | ')}`);
  await writeState(state, file);
  return state;
}
