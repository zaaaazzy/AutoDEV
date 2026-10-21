import type { Pool } from 'pg';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { orderBranch, sprintBranch } from './git-sync.js';
import { gitEnvironment } from './project-command.js';

/** Ein startbarer Stand eines Sprints: ein gemergter Auftrag im Sprint-Branch oder ein noch offener Auftrags-Branch. */
export interface SprintCommit {
  hash: string;
  subject: string;
  date: string;
  /** Auftrag, zu dem der Stand gehört (aus „Merge auftrag/<id>…“ bzw. dem Auftrags-Branch). */
  developmentId: string | null;
  /** Im Sprint-Branch enthalten; false = eigener Auftrags-Branch (z. B. wartet auf Freigabe). */
  merged: boolean;
}

const SEP = '\x1f';
const RECORD = '\x1e';
const MAX_COMMITS = 60;
const SPRINTS = 6;

export function parseSprintLog(output: string): Omit<SprintCommit, 'developmentId' | 'merged'>[] {
  return output
    .split(RECORD)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash = '', subject = '', date = ''] = record.split(SEP);
      return { hash, subject: subject.slice(0, 200), date };
    })
    .filter((commit) => /^[0-9a-f]{40}$/.test(commit.hash));
}

/** „Merge auftrag/1a2b3c4d-…“ bzw. „Auftrag: <uuid>“ → passender Auftrag des Sprints. */
export function orderOf(subject: string, items: { id: string }[]): string | null {
  const prefix = /auftrag\/([0-9a-f]{8})-/.exec(subject)?.[1];
  return prefix ? (items.find((item) => item.id.startsWith(prefix))?.id ?? null) : null;
}

/**
 * Liest je Sprint (die letzten sechs) die Stände für die Auswahl in der Sprint-Ansicht: der Sprint-Branch mit seinen
 * Aufträgen (erste Elternlinie, neueste zuerst) – bei abgeschlossenen Sprints aus dem Merge nach main – plus offene
 * Auftrags-Branches. Läuft im Worker, weil nur er das Repository sieht.
 */
export async function syncSprintCommits(
  pool: Pool,
  project: string,
  cwd: string,
  execute: CommandExecutor = runCommand,
): Promise<void> {
  const git = async (...args: string[]) => {
    const result = await execute(['git', ...args], cwd, { timeoutMs: 15_000, env: gitEnvironment() });
    return result.exitCode === 0 ? result.output.trim() : null;
  };
  const sprints = (
    await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM sprints WHERE project_slug = $1 ORDER BY created_at DESC LIMIT ${SPRINTS}`,
      [project],
    )
  ).rows;
  const format = `--format=%H${SEP}%s${SEP}%cI${RECORD}`;
  for (const sprint of sprints) {
    const branch = sprintBranch(sprint.name);
    const items = (
      await pool.query<{ id: string; title: string; status: string; branch: string | null }>(
        `SELECT id, title, status, review_branch AS branch FROM development_items WHERE sprint_id = $1`,
        [sprint.id],
      )
    ).rows;
    // Nach main gemergt (auch mehrfach, z. B. Nachträge): ab dem ersten Merge bis zum Branch-Ende bzw. letzten Merge.
    const merges = ((await git('log', 'main', '--first-parent', '--format=%H', `--grep=^Merge ${branch}[: ]`)) ?? '')
      .split('\n')
      .filter(Boolean);
    const exists = Boolean(await git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`));
    const end = exists ? branch : merges[0] ? `${merges[0]}^2` : null;
    const range = end ? `${merges.length ? `${merges.at(-1)}^1` : 'main'}..${end}` : null;
    const log = range ? await git('log', '--first-parent', `-${MAX_COMMITS}`, format, range) : null;
    const commits: SprintCommit[] = parseSprintLog(log ?? '').map((commit) => ({
      ...commit,
      developmentId: orderOf(commit.subject, items),
      merged: true,
    }));
    // Aufträge mit eigenem, noch nicht gemergtem Branch (z. B. wartet auf Freigabe).
    for (const item of items.filter((entry) => !['done', 'rejected'].includes(entry.status))) {
      const name = item.branch ?? orderBranch(item);
      const head = await git('log', '-1', format, `refs/heads/${name}`);
      const [commit] = parseSprintLog(head ?? '');
      if (!commit || commits.some((entry) => entry.hash === commit.hash)) continue;
      commits.unshift({
        ...commit,
        subject: `${item.title} (noch nicht im Sprint)`,
        developmentId: item.id,
        merged: false,
      });
    }
    await pool.query(
      `INSERT INTO sprint_commits (sprint_id, branch, commits, updated_at) VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (sprint_id) DO UPDATE SET branch = EXCLUDED.branch, commits = EXCLUDED.commits, updated_at = NOW()
       WHERE sprint_commits.commits IS DISTINCT FROM EXCLUDED.commits OR sprint_commits.branch IS DISTINCT FROM EXCLUDED.branch`,
      [sprint.id, branch, JSON.stringify(commits)],
    );
  }
}
