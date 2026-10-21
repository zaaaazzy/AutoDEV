import type { Response, Router } from 'express';
import type { Pool } from 'pg';
import { isRecord, parseProjectSlug } from '../core/validation.js';
import { access } from './access.js';
import type { GitFix, GitProblem, ProjectGitState } from '../runner/repo-state.js';
import type { Principal } from './roles.js';

/**
 * Git-Zustand der Projektordner (vom Worker erfasst) lesen, Lösungen anfordern und riskante Aktionen davor schützen.
 * Ist der Stand älter als STALE_MS (Worker aus), wird nicht gesperrt: Ein veralteter Befund soll nichts blockieren.
 */
export const STALE_MS = 5 * 60_000;
const FIXES: GitFix[] = ['save_wip', 'checkout_main', 'sync_main'];
const FIX_COLUMNS = `id, fix, role, status, message, requested_by AS "requestedBy", created_at AS "createdAt",
  finished_at AS "finishedAt"`;

/** Welche Aktion geschützt wird: Live schalten betrifft den Projektordner, Freigeben und Sprint starten den Agent-Ordner. */
export type GuardedAction = 'go_live' | 'approve' | 'sprint_start';

export async function loadGitState(
  pool: Pool,
  slug: string,
): Promise<{ state: ProjectGitState | null; stateAt: Date | null; stale: boolean }> {
  const row = (
    await pool.query<{ state: ProjectGitState | null; stateAt: Date | null }>(
      'SELECT state, state_at AS "stateAt" FROM project_git_graphs WHERE project_slug = $1',
      [slug],
    )
  ).rows[0];
  const stateAt = row?.stateAt ?? null;
  return { state: row?.state ?? null, stateAt, stale: !stateAt || Date.now() - stateAt.getTime() > STALE_MS };
}

/** Sperrende Befunde, die für diese Aktion zählen (reine Funktion). */
export function problemsFor(state: ProjectGitState | null, action: GuardedAction): GitProblem[] {
  if (!state) return [];
  const separate = state.folders.some((folder) => folder.role === 'agents');
  return state.problems.filter((problem) => {
    if (problem.severity !== 'block') return false;
    if (action === 'go_live') return problem.role === 'live';
    // Freigeben und Sprint starten arbeiten im Ordner der Agents; der Abstand zu GitHub spielt dort keine Rolle.
    if (problem.code.startsWith('main_')) return false;
    return separate ? problem.role === 'agents' : problem.role === 'live';
  });
}

const ACTION_LABEL: Record<GuardedAction, string> = {
  go_live: 'Live schalten',
  approve: 'Freigeben',
  sprint_start: 'Sprint starten',
};

/**
 * Prüft vor einer riskanten Aktion. Antwortet bei sperrenden Befunden mit 409 und gibt false zurück. Mit
 * `ignoreGit: true` und einer Begründung im Body (bewusste Bestätigung) geht es trotzdem weiter.
 */
export async function guardGit(
  pool: Pool,
  slug: string,
  action: GuardedAction,
  body: unknown,
  response: Response,
): Promise<boolean> {
  const { state, stale } = await loadGitState(pool, slug);
  if (stale) return true;
  const problems = problemsFor(state, action);
  if (!problems.length) return true;
  const reason =
    isRecord(body) && body.ignoreGit === true && typeof body.gitReason === 'string' ? body.gitReason.trim() : '';
  if (reason) {
    console.warn(
      `[${slug}] ${ACTION_LABEL[action]} trotz Git-Befund (${problems.map((p) => p.code).join(', ')}): ${reason}`,
    );
    return true;
  }
  response.status(409).json({
    message: `${ACTION_LABEL[action]} ist gesperrt: ${problems.map((problem) => problem.title).join(' · ')}.`,
    gitProblems: problems,
    gitAction: action,
  });
  return false;
}

export function registerGitStateRoutes(app: Router, pool: Pool): void {
  const me = (response: Response) => response.locals.principal as Principal | undefined;

  app.get('/projects/:slug/git-state', access({ tenant: 'project' }), async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
      const { state, stateAt, stale } = await loadGitState(pool, slug);
      const fix =
        (
          await pool.query(
            `SELECT ${FIX_COLUMNS} FROM git_fix_requests WHERE project_slug = $1 ORDER BY created_at DESC LIMIT 1`,
            [slug],
          )
        ).rows[0] ?? null;
      response.json({ state, stateAt, stale, fix });
    } catch (error) {
      next(error);
    }
  });

  app.post('/projects/:slug/git-fix', access({ role: 'run', tenant: 'project' }), async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      const body = isRecord(request.body) ? request.body : {};
      const fix = FIXES.find((entry) => entry === body.fix);
      const role = body.role === 'agents' ? 'agents' : 'live';
      if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
      if (!fix) return void response.status(400).json({ message: 'Unbekannte Lösung.' });
      const created = (
        await pool.query(
          `INSERT INTO git_fix_requests (project_slug, fix, role, requested_by)
           SELECT slug, $2, $3, $4 FROM projects WHERE slug = $1
           ON CONFLICT (project_slug) WHERE status IN ('requested', 'running') DO NOTHING
           RETURNING ${FIX_COLUMNS}`,
          [slug, fix, role, me(response)?.displayName ?? null],
        )
      ).rows[0];
      if (!created) {
        const exists = (await pool.query('SELECT 1 FROM projects WHERE slug = $1', [slug])).rowCount;
        return void response
          .status(exists ? 409 : 404)
          .json({ message: exists ? 'Eine Git-Lösung läuft bereits – bitte kurz warten.' : 'Projekt nicht gefunden.' });
      }
      await pool.query(`SELECT pg_notify('devlog_work', $1)`, [slug]).catch(() => undefined);
      response.status(201).json({ fix: created });
    } catch (error) {
      next(error);
    }
  });
}
