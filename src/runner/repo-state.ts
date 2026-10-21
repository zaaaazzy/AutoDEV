import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { gitHelpers } from './git-sync.js';

/**
 * Git-Zustand der Projektordner, wie ihn der Worker jede Minute sieht: Branch, offene Änderungen und wie weit das
 * lokale main von GitHub (origin/main) entfernt ist. Daraus entstehen Befunde mit Schwere und möglichen Lösungen.
 * „block“ sperrt riskante Aktionen (Live schalten, Freigeben, Sprint starten), „warn“ zeigt nur einen Hinweis.
 */
export const MAIN = 'main';

/** Branches, die AIdeation selbst anlegt und auf denen ein Ordner stehen darf. */
const OWN_BRANCH = /^(main|master|sprint\/|auftrag\/)/;
const MAX_LISTED = 12;

export type FolderRole = 'live' | 'agents';

export interface FolderSnapshot {
  folder: string;
  role: FolderRole;
  /** null: losgelöster Stand (kein Branch) oder kein Git-Repository. */
  branch: string | null;
  repository: boolean;
  /** Geänderte, versionierte Dateien (gekürzt) und ihre Zahl. */
  changed: string[];
  changedCount: number;
  /** Neue, nicht versionierte Dateien (gekürzt) und ihre Zahl. */
  untracked: string[];
  untrackedCount: number;
  /** Lokales main gegenüber origin/main (Stand des letzten Fetch); null ohne Remote oder ohne main. */
  mainAhead: number | null;
  mainBehind: number | null;
}

export type GitFix = 'save_wip' | 'checkout_main' | 'sync_main';

export type ProblemCode =
  'foreign_branch' | 'uncommitted' | 'untracked' | 'main_diverged' | 'main_ahead' | 'main_behind';

export interface GitProblem {
  code: ProblemCode;
  role: FolderRole;
  folder: string;
  severity: 'block' | 'warn';
  title: string;
  detail: string;
  fixes: GitFix[];
}

export interface ProjectGitState {
  checkedAt: string;
  folders: FolderSnapshot[];
  problems: GitProblem[];
}

/** Was im Moment in einem Ordner passieren darf: Arbeitet gerade ein Agent darin, sind offene Änderungen normal. */
export interface FolderContext {
  /** Agents arbeiten in diesem Ordner (kein eigener Agent-Arbeitsordner). */
  agentsWorkHere: boolean;
  /** Ein Agent-Schritt läuft gerade. */
  agentRunning: boolean;
}

/** Liest den Zustand eines Ordners; Fehler einzelner Befehle machen das Feld leer statt den Worker anzuhalten. */
export async function readFolder(
  folder: string,
  role: FolderRole,
  execute: CommandExecutor = runCommand,
): Promise<FolderSnapshot> {
  const empty: FolderSnapshot = {
    folder,
    role,
    branch: null,
    repository: false,
    changed: [],
    changedCount: 0,
    untracked: [],
    untrackedCount: 0,
    mainAhead: null,
    mainBehind: null,
  };
  if (!existsSync(join(folder, '.git'))) return empty;
  const { git } = gitHelpers(execute, folder);
  const head = await git('symbolic-ref', '--short', '-q', 'HEAD');
  const status = await git('-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=normal');
  const lines = status.exitCode === 0 ? status.output.split('\n').filter(Boolean) : [];
  // Die erste Zeile verliert durch das Trimmen ihr führendes Leerzeichen („ M a.txt“ → „M a.txt“).
  const path = (line: string): string => line.replace(/^[ MADRCUT?!]{1,2}\s+/, '').replace(/^.* -> /, '');
  const untracked = lines.filter((line) => line.startsWith('??')).map(path);
  const changed = lines.filter((line) => !line.startsWith('??')).map(path);
  let mainAhead: number | null = null;
  let mainBehind: number | null = null;
  const remote = await git('rev-parse', '--verify', '--quiet', `refs/remotes/origin/${MAIN}`);
  const local = await git('rev-parse', '--verify', '--quiet', `refs/heads/${MAIN}`);
  if (remote.exitCode === 0 && local.exitCode === 0) {
    const counts = await git('rev-list', '--left-right', '--count', `${MAIN}...origin/${MAIN}`);
    const [ahead, behind] = counts.output.split(/\s+/).map(Number);
    if (counts.exitCode === 0 && Number.isFinite(ahead) && Number.isFinite(behind)) {
      mainAhead = ahead ?? 0;
      mainBehind = behind ?? 0;
    }
  }
  return {
    ...empty,
    repository: true,
    branch: head.exitCode === 0 && head.output ? head.output : null,
    changed: changed.slice(0, MAX_LISTED),
    changedCount: changed.length,
    untracked: untracked.slice(0, MAX_LISTED),
    untrackedCount: untracked.length,
    mainAhead,
    mainBehind,
  };
}

const folderName = (snapshot: FolderSnapshot): string =>
  snapshot.role === 'live' ? `Projektordner ${snapshot.folder}` : `Agent-Arbeitsordner ${snapshot.folder}`;

const list = (items: string[], count: number): string =>
  `${items.slice(0, 5).join(', ')}${count > 5 ? ` und ${count - 5} weitere` : ''}`;

/** Befunde zu einem Ordner. Reine Funktion, damit sie ohne Git testbar ist. */
export function assessFolder(snapshot: FolderSnapshot, context: FolderContext): GitProblem[] {
  if (!snapshot.repository) return [];
  const problems: GitProblem[] = [];
  const where = folderName(snapshot);
  const base = { role: snapshot.role, folder: snapshot.folder };
  const busy = context.agentsWorkHere && context.agentRunning;
  // Losgelöster Stand ist normal: Die Vorschau im Projektordner und der Agent-Worktree stehen so auf main.
  if (
    snapshot.branch &&
    (!OWN_BRANCH.test(snapshot.branch) ||
      (snapshot.role === 'live' && !context.agentsWorkHere && snapshot.branch !== MAIN))
  ) {
    problems.push({
      ...base,
      code: 'foreign_branch',
      severity: 'block',
      title: `Fremder Branch „${snapshot.branch}“ ausgecheckt`,
      detail:
        snapshot.role === 'live'
          ? `${where} steht nicht auf ${MAIN}. Live schalten und Deploy würden diesen Stand ausliefern.`
          : `${where} steht auf einem Branch, den AIdeation nicht angelegt hat.`,
      fixes: snapshot.changedCount ? ['save_wip'] : ['checkout_main'],
    });
  }
  if (snapshot.changedCount && !busy) {
    problems.push({
      ...base,
      code: 'uncommitted',
      severity: 'block',
      title: `${snapshot.changedCount} nicht committete Änderung${snapshot.changedCount === 1 ? '' : 'en'}`,
      detail: `In ${where}: ${list(snapshot.changed, snapshot.changedCount)}. Ein Merge oder Deploy würde sie mitnehmen oder abbrechen.`,
      fixes: ['save_wip'],
    });
  }
  if (snapshot.untrackedCount && !busy) {
    problems.push({
      ...base,
      code: 'untracked',
      severity: 'warn',
      title: `${snapshot.untrackedCount} neue, nicht versionierte Datei${snapshot.untrackedCount === 1 ? '' : 'en'}`,
      detail: `In ${where}: ${list(snapshot.untracked, snapshot.untrackedCount)}.`,
      fixes: ['save_wip'],
    });
  }
  // Der Abstand zu GitHub gilt für das ganze Repository: nur einmal (am Projektordner) melden.
  if (snapshot.role === 'live' && snapshot.mainAhead !== null && snapshot.mainBehind !== null) {
    const ahead = snapshot.mainAhead;
    const behind = snapshot.mainBehind;
    if (ahead && behind) {
      problems.push({
        ...base,
        code: 'main_diverged',
        severity: 'block',
        title: `${MAIN} weicht von GitHub ab`,
        detail: `Lokal ${ahead} Commit${ahead === 1 ? '' : 's'}, die nicht auf GitHub sind, und auf GitHub ${behind}, die lokal fehlen. Ein Push würde abgelehnt.`,
        fixes: ['sync_main'],
      });
    } else if (ahead) {
      problems.push({
        ...base,
        code: 'main_ahead',
        severity: 'warn',
        title: `${ahead} Commit${ahead === 1 ? '' : 's'} auf ${MAIN} nicht auf GitHub`,
        detail: `Das lokale ${MAIN} ist weiter als GitHub. Ohne Push fehlen diese Commits in der CI und auf anderen Rechnern.`,
        fixes: ['sync_main'],
      });
    } else if (behind) {
      problems.push({
        ...base,
        code: 'main_behind',
        severity: 'warn',
        title: `GitHub ist ${behind} Commit${behind === 1 ? '' : 's'} weiter`,
        detail: `Auf GitHub liegen neuere Commits auf ${MAIN}, die lokal noch fehlen.`,
        fixes: ['sync_main'],
      });
    }
  }
  return problems;
}

export function blocking(state: ProjectGitState | null | undefined): GitProblem[] {
  return state?.problems.filter((problem) => problem.severity === 'block') ?? [];
}
