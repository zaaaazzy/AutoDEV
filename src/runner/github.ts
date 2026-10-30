import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CommandExecutor, redactOutput, runCommand } from '../core/command.js';
import { gitEnvironment } from './project-command.js';
import {
  type CiStatus,
  type HosterAdapter,
  HosterError,
  type HosterIssue,
  type PullRequestChecks,
  type PullRequestState,
} from './hoster.js';
import { defined } from '../core/defined.js';

/** GitHub-Brücke je Projekt: aus, nur Issues oder Issues plus Pull Request beim Sprint-Abschluss. */
export const GITHUB_MODES = ['aus', 'issues', 'issues+pr'] as const;
export type GithubMode = (typeof GITHUB_MODES)[number];

/** Labels, deren Issues übernommen werden (Bug vor Idee, falls beide gesetzt sind). */
export const ISSUE_LABELS = ['bug', 'idea'] as const;
export type IssueLabel = (typeof ISSUE_LABELS)[number];

/** Einzige erlaubte gh-Unterbefehle; alles andere wird vor dem Aufruf abgelehnt. */
export const GH_COMMANDS = new Set([
  'auth status',
  'issue list',
  'issue comment',
  'issue close',
  'pr list',
  'pr create',
  'pr checks',
  'pr view',
  'pr merge',
  'run view',
]);

const GH_TIMEOUT_MS = 60_000;
const ISSUE_LIMIT = 100;
const PR_BODY_MAX = 60_000;
const COMMENT_MAX = 60_000;
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const RATE_LIMIT = /rate limit|HTTP 429|abuse detection/i;

/** owner/repo aus einer GitHub-Remote-Adresse (HTTPS oder SSH); andere Hoster oder ungültige Namen ergeben null. */
export function githubRepo(remote: string | null | undefined): string | null {
  const match = remote
    ?.trim()
    .match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/);
  const repo = match?.[1];
  if (!repo || !REPO_PATTERN.test(repo)) return null;
  const name = defined(repo.split('/')[1]);
  return name === '.' || name === '..' ? null : repo;
}

/** Prüft, ob die URL ein Pull Request genau dieses Repositorys ist. */
export function isPullRequestUrl(url: string, repo: string): boolean {
  const match = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/\d{1,10}$/.exec(url);
  return Boolean(match && defined(match[1]).toLowerCase() === repo.toLowerCase());
}

/** Kennung des CI-Laufs aus einem Check-Link (…/actions/runs/<id>/job/<id>). */
export function runIdFromLink(link: string | undefined): string | null {
  return /\/actions\/runs\/(\d{1,20})(?:\/|$)/.exec(link ?? '')?.[1] ?? null;
}

/** Wertet die Checks eines Pull Requests aus: rot vor laufend vor grün; ohne Checks gilt „laufend“. */
export interface CheckRun {
  bucket?: string;
  state?: string;
  link?: string;
  name?: string;
  workflow?: string;
  /** Auslöser des Laufs: push oder pull_request (GitHub prüft einen PR-Branch oft doppelt). */
  event?: string;
}

/**
 * Läuft derselbe Job für den Pull Request und für den Push auf seinen Branch, zählt der Pull-Request-Lauf. Sonst
 * blockierte ein Ausreisser im (gleichwertigen) Push-Lauf den Merge, obwohl die Prüfung des PR grün ist.
 */
export function relevantChecks(checks: CheckRun[]): CheckRun[] {
  const key = (check: CheckRun): string => `${check.workflow ?? ''}\u0000${check.name ?? ''}`;
  const forPullRequest = new Set(checks.filter((check) => check.event === 'pull_request').map(key));
  return checks.filter((check) => check.event !== 'push' || !forPullRequest.has(key(check)));
}

export function evaluateChecks(all: CheckRun[]): PullRequestChecks {
  const checks = relevantChecks(all);
  const bucket = (check: { bucket?: string; state?: string }): string =>
    (check.bucket ?? check.state ?? '').toLowerCase();
  const failed = checks.find((check) =>
    ['fail', 'cancel', 'failure', 'error', 'cancelled', 'timed_out', 'action_required'].includes(bucket(check)),
  );
  if (failed) return { status: 'failure', failedRun: runIdFromLink(failed.link) };
  const passed = (value: string): boolean => ['pass', 'skipping', 'success', 'skipped', 'neutral'].includes(value);
  const status: CiStatus = checks.length && checks.every((check) => passed(bucket(check))) ? 'success' : 'pending';
  return { status, failedRun: null };
}

/** Liest JSON aus der gh-Ausgabe (stdout und stderr sind zusammengeführt). */
function parseJson<T>(output: string): T {
  const text = output.trim();
  try {
    return JSON.parse(text) as T;
  } catch {
    // Warnungen vor oder nach dem JSON: nur den JSON-Teil lesen.
    const start = text.search(/[[{]/);
    const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
    if (start < 0 || end < start) throw new HosterError(`Unerwartete Antwort der GitHub CLI: ${text.slice(0, 200)}`);
    return JSON.parse(text.slice(start, end + 1)) as T;
  }
}

function requireRepo(repo: string): string {
  if (!REPO_PATTERN.test(repo)) throw new HosterError(`Ungültiges Repository: ${repo.slice(0, 120)}`);
  return repo;
}

function requireNumber(number: number): string {
  if (!Number.isSafeInteger(number) || number <= 0) throw new HosterError('Ungültige Issue-Nummer.');
  return String(number);
}

function requireBranch(branch: string): string {
  if (!BRANCH_PATTERN.test(branch) || branch.includes('..')) throw new HosterError('Ungültiger Branch-Name.');
  return branch;
}

/** Zeitpunkt für die GitHub-Suche (updated:>=…), sekundengenau in UTC. */
export function searchTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Führt einen erlaubten gh-Unterbefehl ohne Shell aus (runCommand mit Argumentliste), ohne Rückfragen und mit
 * maskierter Ausgabe. Wirft bei unbekanntem Unterbefehl, bei Fehlern und bei Rate-Limits (dann `rateLimited`).
 */
export function ghRunner(execute: CommandExecutor, cwd: string) {
  // gh startet git im Projektordner: dasselbe gefilterte Environment ohne Hooks wie der Git-Sync.
  const env = gitEnvironment({ GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' });
  return async (
    group: string,
    command: string,
    args: string[],
    accept: (exitCode: number, output: string) => boolean = (code) => code === 0,
  ): Promise<string> => {
    if (!GH_COMMANDS.has(`${group} ${command}`)) throw new HosterError(`gh ${group} ${command} ist nicht erlaubt.`);
    const result = await execute(['gh', group, command, ...args], cwd, { timeoutMs: GH_TIMEOUT_MS, env });
    const output = redactOutput(result.output, process.env);
    if (accept(result.exitCode, output)) return output;
    throw new HosterError(
      `gh ${group} ${command} fehlgeschlagen (Exit-Code ${result.exitCode}): ${output.trim().slice(-400)}`,
      RATE_LIMIT.test(output),
    );
  };
}

/** Schreibt längeren Text in eine temporäre Datei (--body-file), damit er nie als Argument übergeben wird. */
async function withBodyFile<T>(body: string, use: (file: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'devlog-gh-'));
  try {
    const file = join(directory, 'body.md');
    await writeFile(file, body, { mode: 0o600 });
    return await use(file);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** GitHub-Adapter über die gh CLI des Worker-Benutzers (kein Token in Dev Log). */
export function createGithubAdapter(
  repo: string,
  execute: CommandExecutor = runCommand,
  cwd: string = tmpdir(),
): HosterAdapter {
  const gh = ghRunner(execute, cwd);
  const target = (): string => requireRepo(repo);
  const pullRequest = (url: string): string => {
    if (!isPullRequestUrl(url, target())) throw new HosterError('Pull-Request-Link gehört nicht zum Repository.');
    return url;
  };
  return {
    async authStatus() {
      try {
        await gh('auth', 'status', ['--hostname', 'github.com']);
        return { ok: true, message: 'Angemeldet (gh auth status).' };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          message: /ENOENT|nicht gefunden|not found/i.test(detail)
            ? 'GitHub CLI (gh) fehlt auf dem Worker-Rechner: installieren (z. B. „brew install gh“) und mit „gh auth login“ anmelden.'
            : 'Nicht angemeldet: auf dem Worker-Rechner als Worker-Benutzer „gh auth login“ ausführen (GitHub.com), danach „gh auth status“ prüfen.',
        };
      }
    },

    async listIssues(label, since) {
      if (!(ISSUE_LABELS as readonly string[]).includes(label)) throw new HosterError('Label ist nicht erlaubt.');
      const args = ['--repo', target(), '--label', label, '--state', 'open', '--limit', String(ISSUE_LIMIT)];
      if (since) args.push('--search', `updated:>=${searchTimestamp(since)}`);
      args.push('--json', 'number,title,body,labels,url');
      const rows = parseJson<
        { number: number; title: string; body: string; labels: { name: string }[]; url: string }[]
      >(await gh('issue', 'list', args));
      return rows.map((row): HosterIssue => ({
        number: row.number,
        title: String(row.title ?? ''),
        body: String(row.body ?? ''),
        labels: (row.labels ?? []).map((entry) => String(entry.name ?? '').toLowerCase()),
        url: String(row.url ?? ''),
      }));
    },

    async commentIssue(number, body) {
      const issue = requireNumber(number);
      await withBodyFile(body.slice(0, COMMENT_MAX), (file) =>
        gh('issue', 'comment', [issue, '--repo', target(), '--body-file', file]),
      );
    },

    async closeIssue(number) {
      await gh('issue', 'close', [requireNumber(number), '--repo', target(), '--reason', 'completed']);
    },

    async findPullRequest(head) {
      const rows = parseJson<{ url: string }[]>(
        await gh('pr', 'list', [
          '--repo',
          target(),
          '--head',
          requireBranch(head),
          '--state',
          'open',
          '--limit',
          '1',
          '--json',
          'url',
        ]),
      );
      const url = rows[0]?.url;
      return url && isPullRequestUrl(url, target()) ? url : null;
    },

    async createPullRequest({ head, base, title, body }) {
      const output = await withBodyFile(body.slice(0, PR_BODY_MAX), (file) =>
        gh('pr', 'create', [
          '--repo',
          target(),
          '--head',
          requireBranch(head),
          '--base',
          requireBranch(base),
          '--title',
          title.replace(/\s+/g, ' ').trim().slice(0, 200),
          '--body-file',
          file,
        ]),
      );
      const url = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/.exec(output)?.[0];
      if (!url || !isPullRequestUrl(url, target()))
        throw new HosterError('Pull Request angelegt, aber kein Link erkannt.');
      return url;
    },

    async pullRequestChecks(url) {
      // Exit-Code 8 = Checks laufen noch; ohne Checks meldet gh „no checks reported“.
      const output = await gh(
        'pr',
        'checks',
        [pullRequest(url), '--json', 'name,state,bucket,link,workflow,event'],
        (code, text) =>
          code === 0 || code === 8 || (code === 1 && /^\s*[[{]/.test(text)) || /no checks reported/i.test(text),
      );
      if (/no checks reported/i.test(output)) return { status: 'pending', failedRun: null };
      return evaluateChecks(parseJson<CheckRun[]>(output));
    },

    async pullRequestState(url): Promise<PullRequestState> {
      const view = parseJson<{ state?: string; reviewDecision?: string }>(
        await gh('pr', 'view', [pullRequest(url), '--json', 'state,reviewDecision']),
      );
      const state = String(view.state ?? '').toUpperCase();
      return {
        state: state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'open',
        approved: String(view.reviewDecision ?? '').toUpperCase() === 'APPROVED',
      };
    },

    async mergePullRequest(url) {
      await gh('pr', 'merge', [pullRequest(url), '--merge']);
    },

    async failedRunLog(run) {
      if (!/^\d{1,20}$/.test(run)) throw new HosterError('Ungültige Lauf-Kennung.');
      return gh('run', 'view', [run, '--repo', target(), '--log-failed']);
    },
  };
}
