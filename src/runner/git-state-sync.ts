import { realpathSync } from 'node:fs';
import type { Pool } from 'pg';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { acquireTree, treeBusy } from '../core/project-lock.js';
import { sendPush } from '../core/push.js';
import { applyGitFix } from './repo-fix.js';
import { gitHelpers } from './git-sync.js';
import {
  assessFolder,
  type FolderRole,
  type FolderSnapshot,
  type GitFix,
  type GitProblem,
  MAIN,
  type ProjectGitState,
  readFolder,
} from './repo-state.js';
import { AGENT_RUN_STATUS, AGENT_STEP_STATUS } from '../core/status.js';

/** Wie oft der Worker den Stand von GitHub holt (nur Referenzen, ändert keinen Ordner). */
const FETCH_INTERVAL_MS = 10 * 60_000;
const lastFetch = new Map<string, number>();

const same = (a: string, b: string): boolean => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
};

async function agentRunning(pool: Pool, project: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM agent_run_steps s JOIN agent_runs r ON r.id = s.run_id
      WHERE r.project_slug = $1 AND s.status = '${AGENT_STEP_STATUS.running}' LIMIT 1`,
    [project],
  );
  return Boolean(result.rowCount);
}

/** Holt den Stand von GitHub höchstens alle 10 Minuten; Netzfehler ändern nur die Aktualität der Zahlen. */
async function fetchOccasionally(folder: string, execute: CommandExecutor): Promise<void> {
  if (Date.now() - (lastFetch.get(folder) ?? 0) < FETCH_INTERVAL_MS) return;
  lastFetch.set(folder, Date.now());
  const { git } = gitHelpers(execute, folder);
  await git('fetch', '-q', 'origin', MAIN);
}

/** Liest Projekt- und Agent-Ordner, bewertet sie und speichert das Ergebnis (Dashboard, Sprint, Auftrag). */
export async function syncGitState(
  pool: Pool,
  project: string,
  repository: string,
  agentFolder: string,
  execute: CommandExecutor = runCommand,
): Promise<ProjectGitState> {
  const agentsWorkHere = same(repository, agentFolder);
  const running = await agentRunning(pool, project);
  // Holen schreibt Referenzen ins gemeinsame Git-Verzeichnis: nur, wenn gerade kein Agent und niemand im Ordner arbeitet.
  if (!running && !treeBusy(agentFolder) && !treeBusy(repository)) {
    await fetchOccasionally(repository, execute).catch(() => undefined);
  }
  const folders: FolderSnapshot[] = [await readFolder(repository, 'live', execute)];
  if (!agentsWorkHere) folders.push(await readFolder(agentFolder, 'agents', execute));
  const problems: GitProblem[] = folders.flatMap((snapshot) =>
    assessFolder(snapshot, {
      agentsWorkHere: snapshot.role === 'agents' || agentsWorkHere,
      agentRunning: running,
    }),
  );
  const state: ProjectGitState = { checkedAt: new Date().toISOString(), folders, problems };
  const previous = (
    await pool.query<{ state: ProjectGitState | null }>(
      'SELECT state FROM project_git_graphs WHERE project_slug = $1',
      [project],
    )
  ).rows[0]?.state;
  await notifyNewBlocks(pool, project, previous ?? null, state);
  await pool.query(
    `INSERT INTO project_git_graphs (project_slug, state, state_at, updated_at) VALUES ($1, $2, NOW(), NOW())
     ON CONFLICT (project_slug) DO UPDATE SET state = EXCLUDED.state, state_at = NOW()`,
    [project, JSON.stringify(state)],
  );
  return state;
}

const blockKey = (problem: GitProblem): string => `${problem.role}:${problem.code}`;

/** Meldet neu aufgetretene Sperren einmal per Push (nicht bei jeder Minute erneut). */
async function notifyNewBlocks(
  pool: Pool,
  project: string,
  previous: ProjectGitState | null,
  next: ProjectGitState,
): Promise<void> {
  const before = new Set((previous?.problems ?? []).filter((problem) => problem.severity === 'block').map(blockKey));
  const fresh = next.problems.filter((problem) => problem.severity === 'block' && !before.has(blockKey(problem)));
  if (!fresh.length || !previous) return;
  await sendPush(
    pool,
    {
      title: `⚠️ Git-Zustand prüfen · ${project}`,
      body: `${fresh.map((problem) => problem.title).join(' · ')}\nLive schalten und Freigeben sind gesperrt, bis das gelöst ist.`,
      url: `#dashboard?project=${encodeURIComponent(project)}`,
      tag: `git-state-${project}`,
    },
    { project },
  );
}

interface FixRequest {
  id: string;
  fix: GitFix;
  role: FolderRole;
}

const FIX_LABEL: Record<GitFix, string> = {
  save_wip: 'Zwischenstand sichern',
  checkout_main: `Zurück auf ${MAIN}`,
  sync_main: `${MAIN} mit GitHub abgleichen`,
};

/**
 * Nimmt eine angeforderte Lösung für dieses Projekt an und führt sie aus. Danach wird der Zustand sofort neu erfasst,
 * damit die Oberfläche das Ergebnis ohne Warten sieht. Liefert true, wenn etwas zu tun war.
 */
export async function processGitFix(
  pool: Pool,
  project: string,
  repository: string,
  agentFolder: string,
  execute: CommandExecutor = runCommand,
): Promise<boolean> {
  const claimed = await pool.query<FixRequest>(
    `UPDATE git_fix_requests SET status = 'running'
      WHERE id = (SELECT id FROM git_fix_requests WHERE project_slug = $1 AND status = 'requested'
                   ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        -- Nicht neben einem laufenden Auftrag: Commit oder Branch-Wechsel träfe sonst seine Arbeit.
        AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE project_slug = $1 AND status = '${AGENT_RUN_STATUS.running}')
      RETURNING id, fix, role`,
    [project],
  );
  const request = claimed.rows[0];
  if (!request) return false;
  const folder = request.role === 'agents' ? agentFolder : repository;
  let message: string;
  let ok = true;
  // Exklusiv im Ordner: kein Auftrag und kein Assistent arbeitet währenddessen darin.
  const release = await acquireTree(folder);
  try {
    message = await applyGitFix(request.fix, folder, execute);
  } catch (error) {
    ok = false;
    message = error instanceof Error ? error.message : String(error);
  } finally {
    release();
  }
  await pool.query(`UPDATE git_fix_requests SET status = $2, message = $3, finished_at = NOW() WHERE id = $1`, [
    request.id,
    ok ? 'done' : 'failed',
    message.slice(0, 2000),
  ]);
  await syncGitState(pool, project, repository, agentFolder, execute).catch(() => undefined);
  await sendPush(
    pool,
    {
      title: `${ok ? '✓' : '⚠️'} ${FIX_LABEL[request.fix]} · ${project}`,
      body: message.slice(0, 300),
      url: `#dashboard?project=${encodeURIComponent(project)}`,
      tag: `git-fix-${project}`,
    },
    { project },
  ).catch(() => undefined);
  return true;
}
