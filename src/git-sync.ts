import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { type CommandExecutor, redactOutput, runCommand } from './command.js';

const GIT_TIMEOUT_MS = 120_000;
const REMOTE_PATTERN = /^(https:\/\/[^\s@/]+\/[^\s]+|git@[A-Za-z0-9.-]+:[^\s]+|ssh:\/\/git@[^\s]+)$/;

export function isValidGitRemote(value: string): boolean {
  return value.length <= 300 && REMOTE_PATTERN.test(value);
}

export function sprintTag(name: string, id: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `sprint-${slug || 'ohne-name'}-${id.slice(0, 6)}`;
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
  execute: CommandExecutor = runCommand,
): Promise<number> {
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
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  const git = async (...args: string[]) => {
    const result = await execute(['git', ...args], cwd, { timeoutMs: GIT_TIMEOUT_MS, env });
    return { ...result, output: redactOutput(result.output, process.env).trim() };
  };
  const log: string[] = [];
  const must = async (...args: string[]): Promise<string> => {
    const result = await git(...args);
    if (result.exitCode !== 0) {
      throw new Error(`git ${args[0]} fehlgeschlagen: ${result.output.slice(-500)}`);
    }
    return result.output;
  };
  try {
    if (!existsSync(join(cwd, '.git'))) {
      await must('init', '-b', 'main');
      log.push('Repository initialisiert.');
    }
    if (!(await git('config', 'user.email')).output) {
      await must('config', 'user.name', 'Mainty Dev Log');
      await must('config', 'user.email', 'dev-log@mainty.local');
    }
    if (sprint.remote) {
      const current = await git('remote', 'get-url', 'origin');
      await must(...(current.exitCode === 0
        ? ['remote', 'set-url', 'origin', sprint.remote]
        : ['remote', 'add', 'origin', sprint.remote]));
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
