import { execFileSync } from 'node:child_process';
import type { Pool } from 'pg';
import { type CommandExecutor, redactOutput, runCommand } from '../core/command.js';
import { sendPush } from '../core/push.js';

/**
 * „AIdeation neu starten“ (Aktionen im Assistenten): Die Oberfläche fordert den Neustart an, der Worker auf dem Host
 * baut die Container mit `docker compose up -d --build` neu und beendet sich danach selbst. launchd (KeepAlive)
 * startet ihn sofort wieder – mit dem neuen Code und den neuen Agents. Der Stand liegt in app_settings.
 */
export const RESTART_KEY = 'system:restart';
export const RESTART_COMMAND = ['docker', 'compose', 'up', '-d', '--build'];
const BUILD_TIMEOUT_MS = 20 * 60_000;
/** Höchstens so lange auf laufende Aufträge warten; danach werden sie unterbrochen und nach dem Start fortgesetzt. */
export const MAX_WAIT_MS = 15 * 60_000;
const MAX_LOG_CHARS = 4_000;

export type RestartStatus = 'requested' | 'building' | 'restarting' | 'done' | 'failed';

export interface RestartState {
  status: RestartStatus;
  requestedAt: string;
  requestedBy: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  /** Kurze Meldung für die Oberfläche (z. B. „Wartet auf 1 laufenden Auftrag“). */
  message?: string | null;
  /** Ende der Ausgabe von docker compose. */
  log?: string | null;
  /** Kommentar aus der Bestätigung (z. B. warum neu gestartet wird). */
  comment?: string | null;
}

export const OPEN_STATUSES: readonly RestartStatus[] = ['requested', 'building', 'restarting'];

type Queryable = Pick<Pool, 'query'>;

export async function readRestart(pool: Queryable): Promise<RestartState | null> {
  const row = (await pool.query<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', [RESTART_KEY]))
    .rows[0];
  if (!row) return null;
  try {
    return JSON.parse(row.value) as RestartState;
  } catch {
    return null;
  }
}

/** Meldet das Ende eines Neustarts (fertig oder fehlgeschlagen), z. B. per Push. */
export type RestartNotifier = (pool: Queryable, state: RestartState) => Promise<void>;

function currentVersion(): string | null {
  try {
    const head = execFileSync('git', ['log', '-1', '--format=%h %s'], { encoding: 'utf8', timeout: 5_000 }).trim();
    return head ? `Stand: ${head}` : null;
  } catch {
    return null;
  }
}

/** Push an alle Geräte: Ohne diese Meldung sieht man nicht, ob der Neustart durch ist (Container laufen einfach weiter). */
export const notifyRestart: RestartNotifier = async (pool, state) => {
  const done = state.status === 'done';
  await sendPush(pool as Pool, {
    title: done ? '✓ AIdeation neu gestartet' : '⚠ AIdeation-Neustart fehlgeschlagen',
    body: [state.message, done ? currentVersion() : null].filter(Boolean).join('\n'),
    url: '#dashboard',
    tag: 'system-restart',
  }).catch(() => 0);
};

async function writeRestart(
  pool: Queryable,
  state: RestartState,
  notify: RestartNotifier = notifyRestart,
): Promise<RestartState> {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [RESTART_KEY, JSON.stringify(state)],
  );
  if (state.status === 'done' || state.status === 'failed') await notify(pool, state).catch(() => undefined);
  return state;
}

/** Neustart anfordern; läuft schon einer, wird dieser zurückgegeben (created = false). */
export async function requestRestart(
  pool: Queryable,
  requestedBy: string | null,
  now = new Date(),
  comment: string | null = null,
): Promise<{ state: RestartState; created: boolean }> {
  const current = await readRestart(pool);
  if (current && OPEN_STATUSES.includes(current.status)) return { state: current, created: false };
  const state = await writeRestart(pool, {
    status: 'requested',
    requestedAt: now.toISOString(),
    requestedBy,
    comment: comment?.trim().slice(0, 2000) || null,
    message: 'Angefordert – der Worker übernimmt gleich.',
  });
  return { state, created: true };
}

/**
 * Beim Start des Workers: Ein Neustart im Status „restarting“ ist damit abgeschlossen. Ein „building“, das den
 * Worker nicht überlebt hat, gilt als fehlgeschlagen.
 */
export async function completeRestart(
  pool: Queryable,
  now = new Date(),
  notify: RestartNotifier = notifyRestart,
): Promise<RestartState | null> {
  const current = await readRestart(pool);
  if (current?.status === 'restarting') {
    return writeRestart(
      pool,
      {
        ...current,
        status: 'done',
        finishedAt: now.toISOString(),
        message: 'Container neu gebaut, Worker mit neuem Code und neuen Agents gestartet.',
      },
      notify,
    );
  }
  if (current?.status === 'building') {
    return writeRestart(
      pool,
      {
        ...current,
        status: 'failed',
        finishedAt: now.toISOString(),
        message: 'Der Worker wurde während des Neubaus beendet. Bitte erneut starten.',
      },
      notify,
    );
  }
  return current;
}

/** Wo die Oberfläche nach dem Neubau antworten muss (Port aus docker-compose.yml, nur lokal). */
export const HEALTH_URL = 'http://127.0.0.1:3100/health';
const HEALTH_TIMEOUT_MS = 120_000;

export interface RestartOptions {
  /** Antwortet die Oberfläche? Standard: GET HEALTH_URL. */
  health?: () => Promise<boolean>;
  /** Wie lange nach dem Neubau auf eine Antwort gewartet wird. */
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  /** Meldung bei Ende (fertig/fehlgeschlagen); Standard: Push an alle Geräte. */
  notify?: RestartNotifier;
}

async function defaultHealth(): Promise<boolean> {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitHealthy(options: RestartOptions): Promise<boolean> {
  const health = options.health ?? defaultHealth;
  const deadline = Date.now() + (options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS);
  for (;;) {
    if (await health()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, options.healthIntervalMs ?? 3_000));
  }
}

/** Abbild des laufenden Dienstes „dev-log“ vor dem Neubau – zum Zurücksetzen, falls der neue Stand nicht startet. */
export interface PreviousImage {
  id: string;
  repository: string;
  tag: string;
}

export function parseComposeImages(output: string): PreviousImage[] {
  const images: PreviousImage[] = [];
  try {
    const parsed = JSON.parse(output.trim()) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of list) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const id = typeof record.ID === 'string' ? record.ID : null;
      const repository = typeof record.Repository === 'string' ? record.Repository : null;
      const tag = typeof record.Tag === 'string' && record.Tag ? record.Tag : 'latest';
      if (id && repository && /^[\w./:-]+$/.test(repository) && /^[\w:.-]+$/.test(id) && /^[\w.-]+$/.test(tag))
        images.push({ id, repository, tag });
    }
  } catch {
    // Ältere Compose-Versionen ohne JSON-Ausgabe: dann ohne Zurücksetzen.
  }
  return images;
}

/** Selbst gebaute Dienste: Backend (API) und Frontend (Oberfläche) – beide werden bei Bedarf zurückgesetzt. */
export const BUILT_SERVICES = ['dev-log', 'frontend'];

/**
 * Arbeitet einen angeforderten Neustart ab. `busy` liefert die Zahl laufender Aufgaben des Workers; solange welche
 * laufen, wird bis MAX_WAIT_MS gewartet. Ergebnis „restart“: Container sind neu gebaut, der Worker soll sich beenden.
 */
export async function processRestart(
  pool: Queryable,
  installRoot: string,
  busy: () => number,
  execute: CommandExecutor = runCommand,
  now: () => Date = () => new Date(),
  options: RestartOptions = {},
): Promise<'idle' | 'waiting' | 'failed' | 'restart'> {
  const current = await readRestart(pool);
  if (current?.status !== 'requested') return 'idle';
  const running = busy();
  const waited = now().getTime() - Date.parse(current.requestedAt);
  if (running > 0 && waited < MAX_WAIT_MS) {
    const message = `Wartet auf ${running} laufende Aufgabe${running === 1 ? '' : 'n'} (höchstens ${MAX_WAIT_MS / 60_000} Minuten).`;
    if (current.message !== message) await writeRestart(pool, { ...current, message });
    return 'waiting';
  }
  const building = await writeRestart(pool, {
    ...current,
    status: 'building',
    startedAt: now().toISOString(),
    message: `Baut die Container neu: ${RESTART_COMMAND.join(' ')}`,
  });
  const previous = parseComposeImages(
    (
      await execute(['docker', 'compose', 'images', ...BUILT_SERVICES, '--format', 'json'], installRoot, {
        timeoutMs: 30_000,
      }).catch(() => ({ exitCode: 1, durationMs: 0, output: '' }))
    ).output,
  );
  const result = await execute(RESTART_COMMAND, installRoot, { timeoutMs: BUILD_TIMEOUT_MS });
  const log = redactOutput(result.output, process.env).trim().slice(-MAX_LOG_CHARS);
  if (result.exitCode !== 0) {
    await writeRestart(
      pool,
      {
        ...building,
        status: 'failed',
        finishedAt: now().toISOString(),
        message: `${RESTART_COMMAND.join(' ')} ist fehlgeschlagen (Exit-Code ${result.exitCode}). Der Worker läuft mit dem bisherigen Code weiter.`,
        log,
      },
      options.notify,
    );
    return 'failed';
  }
  // Gesundheitsprüfung: Antwortet die Oberfläche nicht, zurück auf das vorherige Abbild; der Worker bleibt auf dem
  // bisherigen Stand und startet nicht neu.
  await writeRestart(pool, { ...building, message: 'Container gebaut – prüft, ob AIdeation antwortet …', log });
  if (!(await waitHealthy(options))) {
    let rolledBack = false;
    if (previous.length) {
      let tagged = true;
      for (const image of previous) {
        const result = await execute(['docker', 'tag', image.id, `${image.repository}:${image.tag}`], installRoot, {
          timeoutMs: 30_000,
        });
        tagged &&= result.exitCode === 0;
      }
      const restarted = tagged
        ? await execute(['docker', 'compose', 'up', '-d', '--no-build', ...BUILT_SERVICES], installRoot, {
            timeoutMs: 5 * 60_000,
          })
        : null;
      rolledBack = restarted?.exitCode === 0 && (await waitHealthy(options));
    }
    await writeRestart(
      pool,
      {
        ...building,
        status: 'failed',
        finishedAt: now().toISOString(),
        message: rolledBack
          ? 'Der neue Stand antwortete nicht – AIdeation läuft wieder mit dem vorherigen Abbild. Der Worker wurde nicht neu gestartet.'
          : 'Der neue Stand antwortet nicht, Zurücksetzen war nicht möglich. Bitte auf dem Mac „docker compose logs dev-log frontend“ prüfen.',
        log,
      },
      options.notify,
    );
    return 'failed';
  }
  await writeRestart(pool, {
    ...building,
    status: 'restarting',
    message: 'Container laufen mit dem neuen Code. Der Worker startet neu …',
    log,
  });
  return 'restart';
}
