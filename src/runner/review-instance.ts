import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { DEVELOPMENT_STATUS } from '../core/status.js';
import { ensureWorktree, reviewWorkspacePath } from './agent-workspace.js';

/**
 * Review-Instanz: Der Auftrag, der auf die Freigabe wartet, läuft in einem eigenen Ordner (<Projekt>-review) mit dem
 * Review-Befehl des Projekts (z. B. Frontend auf 4201, Backend auf 3001, Kopie der Datenbank). Der Worker startet sie
 * losgelöst vom eigenen Prozess (überlebt einen Worker-Neustart), wechselt sie bei einem anderen Auftrag oder neuen
 * Commit und beendet sie, sobald nichts mehr auf eine Freigabe wartet.
 */
interface Instance {
  developmentId: string | null;
  requestedId: string | null;
  commit: string | null;
  pid: number | null;
  status: 'starting' | 'running' | 'failed' | 'stopped';
}

interface Candidate {
  id: string;
  branch: string;
}

export function reviewLogPath(project: string): string {
  const logs = join(homedir(), 'Library', 'Logs');
  return join(existsSync(logs) ? logs : tmpdir(), `dev-log-review-${project}.log`);
}

const alive = (pid: number | null): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Welcher Auftrag gezeigt wird: der gewünschte, sonst der bisherige, sonst der älteste wartende. */
export function chooseReview(
  candidates: Candidate[],
  instance: Pick<Instance, 'developmentId' | 'requestedId'> | null,
) {
  return (
    candidates.find((item) => item.id === instance?.requestedId) ??
    candidates.find((item) => item.id === instance?.developmentId) ??
    candidates[0] ??
    null
  );
}

async function stopProcess(pid: number | null): Promise<void> {
  if (!alive(pid)) return;
  const signal = (name: NodeJS.Signals) => {
    try {
      // Eigene Prozessgruppe (detached): Dev-Server und Kindprozesse gemeinsam beenden.
      process.kill(-pid!, name);
    } catch {
      try {
        process.kill(pid!, name);
      } catch {
        // schon beendet
      }
    }
  };
  signal('SIGTERM');
  for (let waited = 0; waited < 10_000 && alive(pid); waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (alive(pid)) signal('SIGKILL');
}

async function save(pool: Pool, project: string, fields: Partial<Instance> & { message?: string | null }) {
  await pool.query(
    `INSERT INTO review_instances (project_slug, development_id, commit_sha, pid, status, message, updated_at)
     VALUES ($1, $2, $3, $4, COALESCE($5, 'stopped'), $6, NOW())
     ON CONFLICT (project_slug) DO UPDATE SET development_id = $2, commit_sha = $3, pid = $4,
       status = COALESCE($5, review_instances.status), message = $6, updated_at = NOW()`,
    [
      project,
      fields.developmentId ?? null,
      fields.commit ?? null,
      fields.pid ?? null,
      fields.status ?? null,
      fields.message ?? null,
    ],
  );
}

function logTail(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').slice(-6).join('\n').slice(-600);
  } catch {
    return '';
  }
}

export async function syncReviewInstance(
  pool: Pool,
  project: string,
  repository: string,
  execute: CommandExecutor = runCommand,
): Promise<void> {
  const settings = (
    await pool.query<{ mode: string; command: unknown }>(
      'SELECT review_mode AS mode, review_command AS command FROM projects WHERE slug = $1',
      [project],
    )
  ).rows[0];
  const instance =
    (
      await pool.query<Instance>(
        `SELECT development_id AS "developmentId", requested_id AS "requestedId", commit_sha AS commit, pid, status
           FROM review_instances WHERE project_slug = $1`,
        [project],
      )
    ).rows[0] ?? null;
  const candidates = (
    await pool.query<Candidate>(
      `SELECT id, review_branch AS branch FROM development_items
        WHERE project_slug = $1 AND status = '${DEVELOPMENT_STATUS.approval}' AND review_branch IS NOT NULL
        ORDER BY review_since NULLS LAST, updated_at`,
      [project],
    )
  ).rows;
  const command =
    Array.isArray(settings?.command) && settings.command.every((part) => typeof part === 'string')
      ? (settings.command as string[])
      : [];
  const desired = settings && settings.mode !== 'off' && command.length ? chooseReview(candidates, instance) : null;

  if (!desired) {
    if (instance && instance.status !== 'stopped') {
      await stopProcess(instance.pid);
      await save(pool, project, {
        status: 'stopped',
        message: command.length ? 'Kein Auftrag wartet auf Freigabe.' : 'Kein Review-Befehl eingestellt.',
      });
    }
    return;
  }

  const head = await execute(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${desired.branch}`], repository);
  const commit = head.exitCode === 0 ? head.output.trim() : null;
  if (!commit) {
    await save(pool, project, {
      developmentId: desired.id,
      status: 'failed',
      message: `Branch ${desired.branch} nicht gefunden.`,
    });
    return;
  }
  const same = instance?.developmentId === desired.id && instance.commit === commit;
  if (same && instance) {
    if (instance.status === 'failed' || instance.status === 'stopped') return;
    if (alive(instance.pid)) {
      if (instance.status === 'starting') {
        await pool.query(`UPDATE review_instances SET status = 'running', updated_at = NOW() WHERE project_slug = $1`, [
          project,
        ]);
      }
      return;
    }
    await save(pool, project, {
      developmentId: desired.id,
      commit,
      status: 'failed',
      message: `Review-Instanz beendet. Log: ${reviewLogPath(project)}\n${logTail(reviewLogPath(project))}`,
    });
    return;
  }

  // Anderer Auftrag oder neuer Stand: alte Instanz beenden, Ordner auf den Auftrag setzen, neu starten.
  await stopProcess(instance?.pid ?? null);
  const folder = reviewWorkspacePath(repository);
  const problem = await ensureWorktree(repository, folder, execute);
  const checkout = problem
    ? null
    : await execute(['git', 'checkout', '-q', '--detach', '--force', commit], folder, { timeoutMs: 60_000 });
  if (problem || checkout?.exitCode !== 0) {
    await save(pool, project, {
      developmentId: desired.id,
      commit,
      status: 'failed',
      message: `Review-Ordner ${folder} nicht bereit: ${problem ?? checkout?.output.slice(-300)}`,
    });
    return;
  }
  // Übriggebliebene Dateien eines früheren Auftrags entfernen (ignorierte wie node_modules bleiben).
  await execute(['git', 'clean', '-fdq'], folder);

  const log = reviewLogPath(project);
  mkdirSync(join(log, '..'), { recursive: true });
  const output = openSync(log, 'w');
  try {
    const child = spawn(command[0]!, command.slice(1), {
      cwd: folder,
      detached: true,
      stdio: ['ignore', output, output],
      env: {
        ...process.env,
        DEV_LOG_REVIEW: '1',
        DEV_LOG_REVIEW_ITEM: desired.id,
        DEV_LOG_REVIEW_MAIN: repository,
      },
    });
    child.on('error', () => undefined);
    child.unref();
    await save(pool, project, {
      developmentId: desired.id,
      commit,
      pid: child.pid ?? null,
      status: child.pid ? 'starting' : 'failed',
      message: child.pid ? `Startet aus ${folder}. Log: ${log}` : `Review-Befehl startet nicht: ${command.join(' ')}`,
    });
    console.info(`[${project}] Review-Instanz für ${desired.id} gestartet (${folder}).`);
  } finally {
    closeSync(output);
  }
}
