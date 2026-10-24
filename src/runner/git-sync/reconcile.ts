import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { type CommandExecutor, runCommand } from '../../core/command.js';
import { withProjectLock } from '../../core/project-lock.js';
import { sendPush } from '../../core/push.js';
import {
  branchExists,
  CHANGED_FILES_IGNORED,
  checkedOutElsewhere,
  currentBranch,
  gitHelpers,
  type GitHelpers,
  MAIN_BRANCH,
  porcelainPath,
  sprintBranch,
  stageAll,
} from './git-helpers.js';
import { clearStaleGitLocks } from './stale-lock.js';

/**
 * Aufräumen des Agent-Arbeitsordners beim Start des Workers. Wurde der Worker mitten in einem Commit oder Merge
 * beendet, bleiben verwaiste Sperre, halber Merge, Auftrags-Branch oder lose Dateien liegen – und jeder folgende Auftrag
 * scheiterte an „fremden Änderungen“ (Sprint 20). Grundsatz: nichts verwerfen. Unterbrochene Aufträge bekommen einen
 * WIP-Commit auf ihrem Branch (der nächste Lauf setzt dort fort), übrige Änderungen werden auf einem eigenen Branch
 * wip/neustart-… geparkt. Den Ordner der Menschen (ohne eigenen Agent-Arbeitsordner) fasst nur die Sperren-Prüfung an.
 */
export interface ReconcileResult {
  actions: string[];
}

async function abortInProgress(git: GitHelpers['git'], gitDir: string, actions: string[]): Promise<void> {
  if ((await git('rev-parse', '-q', '--verify', 'MERGE_HEAD')).exitCode === 0) {
    await git('merge', '--abort');
    actions.push('Halben Merge abgebrochen.');
  }
  if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) {
    await git('rebase', '--abort');
    actions.push('Halben Rebase abgebrochen.');
  }
  if ((await git('rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD')).exitCode === 0) {
    await git('cherry-pick', '--abort');
    actions.push('Halben Cherry-Pick abgebrochen.');
  }
}

/** Basis eines Auftrags-Branchs: Sprint-Branch seines Sprints (falls vorhanden), sonst main. */
async function baseOf(pool: Pool, project: string, branch: string, git: GitHelpers['git']): Promise<string> {
  const prefix = /^auftrag\/([0-9a-f]{8})-/.exec(branch)?.[1];
  if (prefix) {
    const row = (
      await pool.query<{ name: string | null }>(
        `SELECT s.name FROM development_items d LEFT JOIN sprints s ON s.id = d.sprint_id
          WHERE d.project_slug = $1 AND d.id::text LIKE $2 LIMIT 1`,
        [project, `${prefix}%`],
      )
    ).rows[0];
    if (row?.name && (await branchExists(git, sprintBranch(row.name)))) return sprintBranch(row.name);
  }
  return MAIN_BRANCH;
}

async function openChanges(git: GitHelpers['git']): Promise<string[]> {
  const status = await git('-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=all');
  if (status.exitCode !== 0) return [];
  return status.output
    .split('\n')
    .filter(Boolean)
    .map(porcelainPath)
    .filter((path) => path && !CHANGED_FILES_IGNORED.some((prefix) => path.startsWith(prefix)));
}

const stamp = (now: Date): string =>
  now
    .toISOString()
    .slice(0, 16)
    .replace(/[-:T]/g, '')
    .replace(/^(\d{8})/, '$1-');

export async function reconcileWorkingTree(
  pool: Pool,
  project: string,
  repository: string,
  agentFolder: string,
  rawExecute: CommandExecutor = runCommand,
  now: Date = new Date(),
): Promise<ReconcileResult> {
  const actions: string[] = [];
  const separate = repository !== agentFolder;
  // Beim Start laufen keine alten git-Prozesse mehr (killPreviousProcesses): jede ungehaltene Sperre ist verwaist.
  for (const folder of separate ? [agentFolder, repository] : [agentFolder]) {
    const cleared = await clearStaleGitLocks(folder, now.getTime(), { minAgeMs: 0 }).catch(() => null);
    if (cleared) actions.push(cleared);
  }
  if (!separate || !existsSync(join(agentFolder, '.git'))) return { actions };
  const execute: CommandExecutor = (command, directory, options) =>
    withProjectLock(agentFolder, () => rawExecute(command, directory, options));
  const helpers = gitHelpers(execute, agentFolder);
  const { git, must } = helpers;
  const gitDir = (await git('rev-parse', '--absolute-git-dir')).output;
  await abortInProgress(git, gitDir, actions);

  let branch = await currentBranch(git);
  if (branch.startsWith('auftrag/')) {
    // Unterbrochener Auftrag: Zwischenstand auf seinem Branch sichern und zur Basis zurück (der Lauf setzt dort fort).
    await stageAll(git, must, undefined, { orderOnly: true });
    if ((await git('diff', '--cached', '--name-only')).output) {
      await must('commit', '-q', '-m', 'WIP: durch Neustart des Workers unterbrochen');
      actions.push(`Zwischenstand des unterbrochenen Auftrags auf ${branch} gesichert.`);
    }
    const base = await baseOf(pool, project, branch, git);
    if (await checkedOutElsewhere(git, base, agentFolder)) await must('checkout', '-q', '--detach', base);
    else await must('checkout', '-q', base);
    actions.push(`Arbeitsordner von ${branch} zurück auf ${base}.`);
    branch = await currentBranch(git);
  }

  if ((await openChanges(git)).length) {
    // Lose Dateien (z. B. halb übernommener Auftrag): auf eigenem Branch parken, Ordner zurück auf den Ausgangsstand.
    const start = branch === 'HEAD' ? await must('rev-parse', 'HEAD') : branch;
    const park = `wip/neustart-${stamp(now)}`;
    await must('switch', '-q', '-c', park);
    await stageAll(git, must, []);
    if ((await git('diff', '--cached', '--name-only')).output) {
      await must(
        'commit',
        '-q',
        '-m',
        'WIP: nach Neustart im Arbeitsordner gefunden',
        '-m',
        'Von AIdeation beim Start des Workers geparkt, damit kein Auftrag an fremden Änderungen scheitert.',
      );
      actions.push(`Offene Änderungen auf ${park} geparkt.`);
    }
    await must('switch', '-q', ...(branch === 'HEAD' ? ['--detach', start] : [start]));
    if (!actions.some((action) => action.includes(park))) await git('branch', '-q', '-D', park);
  }

  if (actions.length) {
    console.info(`[${project}] Arbeitsordner nach Neustart aufgeräumt: ${actions.join(' ')}`);
    await sendPush(
      pool,
      {
        title: `🧹 Arbeitsordner aufgeräumt · ${project}`,
        body: actions.join(' ').slice(0, 300),
        url: `#dashboard?project=${encodeURIComponent(project)}`,
        tag: `reconcile-${project}`,
      },
      { project },
    ).catch(() => undefined);
  }
  return { actions };
}
