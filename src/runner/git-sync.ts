import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Pool } from 'pg';
import { withProjectLock } from '../core/project-lock.js';
import { type CommandExecutor, redactOutput, runCommand } from '../core/command.js';

const GIT_TIMEOUT_MS = 120_000;
const REMOTE_PATTERN = /^(https:\/\/[^\s@/]+\/[^\s]+|git@[A-Za-z0-9.-]+:[^\s]+|ssh:\/\/git@[^\s]+)$/;

export function isValidGitRemote(value: string): boolean {
  return value.length <= 300 && REMOTE_PATTERN.test(value);
}

/** Der Worker läuft ohne Terminal und Zugangsdaten-Dialog: GitHub-HTTPS-Adressen werden über SSH (Schlüssel) gepusht. */
export function pushRemote(remote: string): string {
  const match = remote.match(/^https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/);
  return match ? `git@github.com:${match[1]}.git` : remote;
}

export function sprintTag(name: string, id: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `sprint-${slug || 'ohne-name'}-${id.slice(0, 6)}`;
}

const INTERNAL_EXCLUDES = ['.dev-log-backups/', '.dev-log/', '.env', '.env.*'];

/** Hält Agent-Sicherungen, Anhänge und .env-Dateien aus dem automatischen Commit heraus (lokal, ohne .gitignore zu ändern). */
async function excludeInternalFolders(cwd: string): Promise<void> {
  const file = join(cwd, '.git', 'info', 'exclude');
  try {
    const current = await readFile(file, 'utf8').catch(() => '');
    const missing = INTERNAL_EXCLUDES.filter((entry) => !current.split(/\r?\n/).includes(entry));
    if (!missing.length) return;
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
  } catch {
    // Ohne Schreibzugriff bleibt das Verhalten wie bisher.
  }
}

function gitHelpers(execute: CommandExecutor, cwd: string) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
  };
  const git = async (...args: string[]) => {
    const result = await execute(['git', ...args], cwd, { timeoutMs: GIT_TIMEOUT_MS, env });
    return { ...result, output: redactOutput(result.output, process.env).trim() };
  };
  const must = async (...args: string[]): Promise<string> => {
    const result = await git(...args);
    if (result.exitCode !== 0) {
      throw new Error(`git ${args[0]} fehlgeschlagen: ${result.output.slice(-500)}`);
    }
    return result.output;
  };
  return { git, must };
}

type GitHelpers = ReturnType<typeof gitHelpers>;

/** Initialisiert das Repository bei Bedarf, setzt eine Commit-Identität und schließt interne Ordner aus. Gibt zurück, ob neu initialisiert wurde. */
async function ensureRepository(git: GitHelpers['git'], must: GitHelpers['must'], cwd: string): Promise<boolean> {
  let initialized = false;
  if (!existsSync(join(cwd, '.git'))) {
    await must('init', '-b', 'main');
    initialized = true;
  }
  if (!(await git('config', 'user.email')).output) {
    await must('config', 'user.name', 'Dev Log');
    await must('config', 'user.email', 'dev-log@localhost');
  }
  await excludeInternalFolders(cwd);
  return initialized;
}

/** Conventional-Commits-Betreff: Typ aus der Auftragsart, Sprint als Scope, Titel auf eine Zeile gekürzt. */
export function taskCommitMessage(
  kind: string | undefined,
  sprintName: string,
  title: string,
  itemId: string,
): [string, string] {
  const type = kind === 'bug' ? 'fix' : 'feat';
  const scope =
    sprintName
      .replace(/[()\r\n:]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40) || 'sprint';
  const subject = title.replace(/\s+/g, ' ').trim().slice(0, 72) || 'Auftrag';
  return [
    `${type}(${scope}): ${subject}`,
    `Auftrag: ${itemId}\nSprint: ${sprintName}\nAutomatisch erstellt vom Dev Log.`,
  ];
}

export interface Worktree {
  /** Folder the order's agents work in. */
  path: string;
  branch: string;
  /** The project folder the branch is merged into. */
  repo: string;
}

/** Worktrees live outside the project folder, so test runners and linters there never pick them up. */
export function worktreeRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.DEV_LOG_WORKTREE_ROOT?.trim() || join(homedir(), '.dev-log', 'worktrees');
}

/**
 * Opens the order's own worktree on branch devlog/<id>, or reopens it after a failed or interrupted run so the
 * retry continues with its changes. node_modules of the project folder is linked in, so tests run without a new
 * install.
 */
export async function openWorktree(
  cwd: string,
  project: string,
  itemId: string,
  rawExecute: CommandExecutor = runCommand,
): Promise<Worktree> {
  const execute: CommandExecutor = (command, directory, options) =>
    withProjectLock(cwd, () => rawExecute(command, directory, options));
  const { git, must } = gitHelpers(execute, cwd);
  await ensureRepository(git, must, cwd);
  if ((await git('rev-parse', '--verify', 'HEAD')).exitCode !== 0) {
    throw new Error('Das Repository hat noch keinen Commit – isolierte Läufe brauchen einen Ausgangsstand.');
  }
  const id = itemId.slice(0, 8);
  const worktree = { path: join(worktreeRoot(), project, id), branch: `devlog/${id}`, repo: cwd };
  if (!existsSync(worktree.path)) {
    await must('worktree', 'prune');
    const branchExists = (await git('rev-parse', '--verify', `refs/heads/${worktree.branch}`)).exitCode === 0;
    await mkdir(dirname(worktree.path), { recursive: true });
    await must(
      'worktree',
      'add',
      ...(branchExists ? [worktree.path, worktree.branch] : ['-b', worktree.branch, worktree.path, 'HEAD']),
    );
  }
  const modules = join(cwd, 'node_modules');
  if (existsSync(modules) && !existsSync(join(worktree.path, 'node_modules'))) {
    await symlink(modules, join(worktree.path, 'node_modules'), 'dir');
  }
  return worktree;
}

/**
 * Commits the order's changes on its branch and merges them into the project folder's current branch, then removes
 * the worktree. A failed merge is aborted and the branch kept, so nothing in the project folder changes.
 */
export async function closeWorktree(
  worktree: Worktree,
  item: { id: string; title: string; kind?: string },
  sprintName: string | null,
  rawExecute: CommandExecutor = runCommand,
): Promise<{ merged: boolean; message: string }> {
  const execute: CommandExecutor = (command, directory, options) =>
    withProjectLock(worktree.repo, () => rawExecute(command, directory, options));
  const tree = gitHelpers(execute, worktree.path);
  const repo = gitHelpers(execute, worktree.repo);
  await tree.must('add', '-A', '--', '.', ':(exclude)node_modules');
  if ((await tree.git('diff', '--cached', '--quiet')).exitCode !== 0) {
    const [subject, body] = taskCommitMessage(item.kind, sprintName ?? 'auftrag', item.title, item.id);
    await tree.must('commit', '-m', subject, '-m', body);
  }
  const merge = await repo.git('merge', '--no-edit', worktree.branch);
  if (merge.exitCode !== 0) {
    await repo.git('merge', '--abort');
    return {
      merged: false,
      message: `Die Änderungen liegen auf Branch \`${worktree.branch}\`, ließen sich aber nicht in den Projektordner übernehmen (Konflikt oder lokale Änderungen). Bitte manuell mergen.\n\n${merge.output.slice(-1500)}`,
    };
  }
  await repo.must('worktree', 'remove', '--force', worktree.path);
  await repo.git('branch', '-d', worktree.branch);
  return { merged: true, message: `Branch ${worktree.branch} in den Projektordner übernommen.` };
}

/** Erstellt nach einem erledigten Sprint-Auftrag einen lokalen Commit (kein Push; den übernimmt die Sprint-Sicherung). */
export async function commitTaskToGit(
  cwd: string,
  item: { id: string; title: string; kind?: string },
  sprintName: string,
  rawExecute: CommandExecutor = runCommand,
): Promise<string | null> {
  const execute: CommandExecutor = (command, directory, options) =>
    withProjectLock(cwd, () => rawExecute(command, directory, options));
  const { git, must } = gitHelpers(execute, cwd);
  try {
    await ensureRepository(git, must, cwd);
    await must('add', '-A');
    if (!(await must('status', '--porcelain'))) return null;
    const [subject, body] = taskCommitMessage(item.kind, sprintName, item.title, item.id);
    await must('commit', '-m', subject, '-m', body);
    return await must('rev-parse', '--short', 'HEAD');
  } catch (error) {
    console.error(
      `Auftrags-Commit für ${item.id} fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

interface PendingSprint {
  id: string;
  name: string;
  action: 'push' | 'pull' | null;
  remote: string | null;
}

async function configureOrigin(git: GitHelpers['git'], must: GitHelpers['must'], remote: string): Promise<void> {
  const current = await git('remote', 'get-url', 'origin');
  const target = pushRemote(remote);
  await must(
    ...(current.exitCode === 0 ? ['remote', 'set-url', 'origin', target] : ['remote', 'add', 'origin', target]),
  );
}

interface SyncResult {
  commit: string;
  branch: string;
  log: string[];
}

/** Commits the working tree with the sprint name, tags it, and pushes when the project has a repository URL. */
async function pushSprint(helpers: GitHelpers, sprint: PendingSprint, log: string[]): Promise<SyncResult> {
  const { must } = helpers;
  await must('add', '-A');
  if (await must('status', '--porcelain')) {
    await must('commit', '-m', `Sprint: ${sprint.name}`, '-m', 'Automatisch gesichert vom Dev Log.');
    log.push('Commit erstellt.');
  } else {
    log.push('Keine Änderungen seit dem letzten Commit.');
  }
  const tag = sprintTag(sprint.name, sprint.id);
  await must('tag', '-f', tag);
  const commit = await must('rev-parse', '--short', 'HEAD');
  const branch = await must('rev-parse', '--abbrev-ref', 'HEAD');
  if (sprint.remote) {
    await must('push', '-u', 'origin', 'HEAD');
    await must('push', '--force', 'origin', `refs/tags/${tag}`);
    log.push(`Nach GitHub gepusht (${tag}).`);
  } else {
    log.push('Kein GitHub-Repository am Projekt hinterlegt – nur lokal gesichert.');
  }
  return { commit, branch, log };
}

/** Holt den Stand von GitHub per Fast-Forward; lokale Änderungen oder abweichende Historie brechen mit Fehlermeldung ab. */
async function pullSprint(helpers: GitHelpers, sprint: PendingSprint, log: string[]): Promise<SyncResult> {
  const { must } = helpers;
  if (!sprint.remote) {
    throw new Error('Kein GitHub-Repository am Projekt hinterlegt.');
  }
  const branch = await must('rev-parse', '--abbrev-ref', 'HEAD');
  await must('pull', '--ff-only', 'origin', branch);
  log.push('Stand von GitHub geladen.');
  return { commit: await must('rev-parse', '--short', 'HEAD'), branch, log };
}

/** Works through the next queued Git request (push or pull) of the project's sprints. */
export async function syncSprintToGit(
  pool: Pool,
  project: string,
  cwd: string,
  rawExecute: CommandExecutor = runCommand,
): Promise<number> {
  const execute: CommandExecutor = (command, directory, options) =>
    withProjectLock(cwd, () => rawExecute(command, directory, options));
  await pool.query(
    `UPDATE sprints SET git_sync = 'pending' WHERE project_slug = $1 AND git_sync = 'running'
        AND updated_at < NOW() - INTERVAL '30 minutes'`,
    [project],
  );
  const claimed = await pool.query<PendingSprint>(
    `UPDATE sprints s SET git_sync = 'running'
      WHERE s.id = (SELECT id FROM sprints WHERE project_slug = $1 AND git_sync = 'pending'
                     ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING s.id, s.name, s.git_action AS action,
                (SELECT git_remote FROM projects WHERE slug = s.project_slug) AS remote`,
    [project],
  );
  const sprint = claimed.rows[0];
  if (!sprint) {
    return 0;
  }
  const helpers = gitHelpers(execute, cwd);
  const log: string[] = [];
  try {
    if (await ensureRepository(helpers.git, helpers.must, cwd)) {
      log.push('Repository initialisiert.');
    }
    if (sprint.remote) {
      await configureOrigin(helpers.git, helpers.must, sprint.remote);
    }
    const result = await (sprint.action === 'pull' ? pullSprint : pushSprint)(helpers, sprint, log);
    await pool.query(
      `UPDATE sprints SET git_sync = 'done', git_message = $2, git_commit = $3, git_branch = $4, git_synced_at = NOW() WHERE id = $1`,
      [sprint.id, result.log.join(' '), result.commit, result.branch],
    );
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(`UPDATE sprints SET git_sync = 'failed', git_message = $2, git_synced_at = NOW() WHERE id = $1`, [
      sprint.id,
      [...log, message].join(' ').slice(0, 1500),
    ]);
    console.error(`Git-Sicherung für Sprint ${sprint.id} fehlgeschlagen: ${message}`);
    return 0;
  }
}
