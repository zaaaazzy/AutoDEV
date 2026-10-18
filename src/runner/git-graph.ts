import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Pool } from 'pg';

const exec = promisify(execFile);
const MAX_COMMITS = 80;
const SEP = '\x1f';

/** Git-Verlauf eines Projekts fürs Dashboard; der Worker liest ihn, weil nur er die Projektordner sieht. */
export interface GitCommit {
  hash: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
  refs: string[];
  /** Auf dem Remote vorhanden (sonst führt ein GitHub-Link ins Leere). */
  pushed: boolean;
}

export interface GitGraph {
  /** Web-Adresse des Repositorys (nur GitHub), z. B. https://github.com/owner/repo */
  webUrl: string | null;
  head: string | null;
  commits: GitCommit[];
}

/** Macht aus der Remote-Adresse (SSH oder HTTPS) die GitHub-Webadresse; andere Hoster bleiben ohne Link. */
export function githubWebUrl(remote: string): string | null {
  const match = remote
    .trim()
    .match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  return match ? `https://github.com/${match[1]}` : null;
}

export function parseGitLog(output: string): GitCommit[] {
  return output
    .split('\n')
    .filter((line) => line.includes(SEP))
    .map((line) => {
      const [hash = '', parents = '', author = '', date = '', subject = '', refs = ''] = line.split(SEP);
      return {
        hash,
        parents: parents.split(' ').filter(Boolean),
        author: author.slice(0, 80),
        date,
        subject: subject.slice(0, 200),
        refs: refs
          .split(', ')
          .map((ref) => ref.replace(/^HEAD -> /, '').trim())
          .filter((ref) => ref && ref !== 'HEAD' && !ref.endsWith('/HEAD')),
        pushed: false,
      };
    })
    .filter((commit) => /^[0-9a-f]{40}$/.test(commit.hash));
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

export async function readGitGraph(cwd: string): Promise<GitGraph | null> {
  const log = await git(
    cwd,
    'log',
    '--all',
    '--topo-order',
    `-n${MAX_COMMITS}`,
    `--format=%H${SEP}%P${SEP}%an${SEP}%aI${SEP}%s${SEP}%D`,
  ).catch(() => null);
  if (log === null) return null;
  const remote = await git(cwd, 'remote', 'get-url', 'origin').catch(() => '');
  const head = (await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').catch(() => '')).trim();
  const remoteCommits = new Set(
    (await git(cwd, 'rev-list', '--remotes', '-n5000').catch(() => '')).split('\n').filter(Boolean),
  );
  const commits = parseGitLog(log).map((commit) => ({ ...commit, pushed: remoteCommits.has(commit.hash) }));
  return { webUrl: githubWebUrl(remote), head: head && head !== 'HEAD' ? head : null, commits };
}

/** Speichert den Verlauf nur, wenn er sich geändert hat. */
export async function syncGitGraph(pool: Pool, project: string, cwd: string): Promise<void> {
  const graph = await readGitGraph(cwd);
  await pool.query(
    `INSERT INTO project_git_graphs (project_slug, graph, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (project_slug) DO UPDATE SET graph = EXCLUDED.graph, updated_at = NOW()
     WHERE project_git_graphs.graph IS DISTINCT FROM EXCLUDED.graph`,
    [project, graph ? JSON.stringify(graph) : null],
  );
}
