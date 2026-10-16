import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Pool } from 'pg';
import { withProjectLock } from './project-lock.js';
import { type CommandExecutor, redactOutput, runCommand } from './command.js';

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
  const slug = name.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
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
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new' };
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
    await must('config', 'user.name', 'Mainty Dev Log');
    await must('config', 'user.email', 'dev-log@mainty.local');
  }
  await excludeInternalFolders(cwd);
  return initialized;
}

/** Conventional-Commits-Betreff: Typ aus der Auftragsart, Sprint als Scope, Titel auf eine Zeile gekürzt. */
export function taskCommitMessage(kind: string | undefined, sprintName: string, title: string, itemId: string): [string, string] {
  const type = kind === 'bug' ? 'fix' : 'feat';
  const scope = sprintName.replace(/[()\r\n:]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'sprint';
  const subject = title.replace(/\s+/g, ' ').trim().slice(0, 72) || 'Auftrag';
  return [`${type}(${scope}): ${subject}`, `Auftrag: ${itemId}\nSprint: ${sprintName}\nAutomatisch erstellt vom Mainty Dev Log.`];
}

/** Erstellt nach einem erledigten Sprint-Auftrag einen lokalen Commit (kein Push; den übernimmt die Sprint-Sicherung). */
export async function commitTaskToGit(
  cwd: string,
  item: { id: string; title: string; kind?: string },
  sprintName: string,
  rawExecute: CommandExecutor = runCommand,
): Promise<string | null> {
  const execute: CommandExecutor = (command, directory, options) => withProjectLock(cwd, () => rawExecute(command, directory, options));
  const { git, must } = gitHelpers(execute, cwd);
  try {
    await ensureRepository(git, must, cwd);
    await must('add', '-A');
    if (!(await must('status', '--porcelain'))) return null;
    const [subject, body] = taskCommitMessage(item.kind, sprintName, item.title, item.id);
    await must('commit', '-m', subject, '-m', body);
    return await must('rev-parse', '--short', 'HEAD');
  } catch (error) {
    console.error(`Auftrags-Commit für ${item.id} fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

interface PendingSprint {
  id: string;
  name: string;
  remote: string | null;
}

/** Commits the working tree with the sprint name, tags it, and pushes when the project has a repository URL. */
export async function syncSprintToGit(
  pool: Pool,
  project: string,
  cwd: string,
  rawExecute: CommandExecutor = runCommand,
): Promise<number> {
  const execute: CommandExecutor = (command, directory, options) => withProjectLock(cwd, () => rawExecute(command, directory, options));
  await pool.query(
    `UPDATE sprints SET git_sync = 'pending' WHERE project_slug = $1 AND git_sync = 'running'
        AND updated_at < NOW() - INTERVAL '30 minutes'`, [project],
  );
  const claimed = await pool.query<PendingSprint>(
    `UPDATE sprints s SET git_sync = 'running'
      WHERE s.id = (SELECT id FROM sprints WHERE project_slug = $1 AND git_sync = 'pending'
                     ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING s.id, s.name, (SELECT git_remote FROM projects WHERE slug = s.project_slug) AS remote`,
    [project],
  );
  const sprint = claimed.rows[0];
  if (!sprint) {
    return 0;
  }
  const { git, must } = gitHelpers(execute, cwd);
  const log: string[] = [];
  try {
    if (await ensureRepository(git, must, cwd)) {
      log.push('Repository initialisiert.');
    }
    if (sprint.remote) {
      const current = await git('remote', 'get-url', 'origin');
      const target = pushRemote(sprint.remote);
      await must(...(current.exitCode === 0
        ? ['remote', 'set-url', 'origin', target]
        : ['remote', 'add', 'origin', target]));
    }
    await must('add', '-A');
    if (await must('status', '--porcelain')) {
      await must('commit', '-m', `Sprint: ${sprint.name}`, '-m', 'Automatisch gesichert vom Mainty Dev Log.');
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
    await pool.query(
      `UPDATE sprints SET git_sync = 'done', git_message = $2, git_commit = $3, git_branch = $4, git_synced_at = NOW() WHERE id = $1`,
      [sprint.id, log.join(' '), commit, branch],
    );
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(
      `UPDATE sprints SET git_sync = 'failed', git_message = $2, git_synced_at = NOW() WHERE id = $1`,
      [sprint.id, [...log, message].join(' ').slice(0, 1500)],
    );
    console.error(`Git-Sicherung für Sprint ${sprint.id} fehlgeschlagen: ${message}`);
    return 0;
  }
}
