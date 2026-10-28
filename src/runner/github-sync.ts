import type { Pool } from 'pg';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { pollSprintReviews, sprintTag } from './git-sync.js';
import { goLive } from './go-live.js';
import { createGithubAdapter, githubRepo, type GithubMode } from './github.js';
import { type HosterAdapter, HosterError, type HosterIssue, UNTRUSTED_END, UNTRUSTED_START } from './hoster.js';

/** Issues höchstens alle 5 Minuten abfragen (Rate-Limit), Pull Requests alle 2 Minuten. */
export const ISSUE_INTERVAL_MS = 5 * 60_000;
export const REVIEW_INTERVAL_MS = 2 * 60_000;
/** Anmeldung erneut prüfen: angemeldet alle 30 Minuten, sonst bei jedem Issue-Intervall. */
const AUTH_RECHECK_MS = 30 * 60_000;
/** Überlappung beim „seit dem letzten Lauf“-Filter, damit kein Issue an der Grenze verloren geht. */
const SINCE_OVERLAP_MS = 60_000;
const DESCRIPTION_MAX = 8_000;

interface GithubSettings {
  mode: GithubMode;
  remote: string | null;
  requireApproval: boolean;
  syncedAt: Date | null;
  auth: 'ok' | 'missing' | null;
  authCheckedAt: Date | null;
}

/** Laufzeitstand je Projekt: Pause nach Rate-Limit und letzte PR-Abfrage. */
const runtime = new Map<string, { pausedUntil: number; reviewsAt: number }>();

/** Ersetzt Bilder (Markdown und HTML) durch reine Links: Bilder werden nie geladen, nur verlinkt. */
export function imagesAsLinks(body: string): string {
  return body
    .replace(
      /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
      (_match, alt: string, url: string) => `[Bild${alt.trim() ? `: ${alt.trim()}` : ''}](${url})`,
    )
    .replace(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi, (_match, url: string) => `[Bild](${url})`)
    .replace(/<img\b[^>]*>/gi, '[Bild]');
}

/** Beschreibung aus einem Issue: Link zum Issue, dann der fremde Text – gekürzt, markiert, Bilder nur als Link. */
export function issueDescription(issue: HosterIssue, ref: string): string {
  const body = imagesAsLinks(issue.body.replace(/\r/g, '')).trim().slice(0, DESCRIPTION_MAX);
  return [
    `Aus GitHub übernommen: [GitHub ${ref}](${issue.url})`,
    body ? `${UNTRUSTED_START}\n${body}\n${UNTRUSTED_END}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function issueTitle(issue: HosterIssue): string {
  return issue.title.replace(/\s+/g, ' ').trim().slice(0, 180) || `GitHub-Issue #${issue.number}`;
}

/**
 * Übernimmt offene Issues mit Label `bug` bzw. `idea` als Bug bzw. Idee (`source = 'github'`, `external_ref =
 * owner/repo#N`). Der eindeutige Index (project_slug, external_ref) verhindert Doppelimporte, auch bei parallelen
 * Läufen; ein Issue mit beiden Labels wird zum Bug. Gibt die Zahl der neuen Einträge zurück.
 */
export async function importIssues(
  pool: Pool,
  project: string,
  repo: string,
  adapter: HosterAdapter,
  since: Date | null,
): Promise<number> {
  let created = 0;
  for (const label of ['bug', 'idea'] as const) {
    for (const issue of await adapter.listIssues(label, since)) {
      if (!issue.labels.includes(label) || (label === 'idea' && issue.labels.includes('bug'))) continue;
      if (!Number.isSafeInteger(issue.number) || issue.number <= 0) continue;
      const ref = `${repo}#${issue.number}`;
      const values = [project, issueTitle(issue), issueDescription(issue, ref), ref];
      const result =
        label === 'bug'
          ? await pool.query(
              `INSERT INTO bugs (project_slug, title, description, severity, source, external_ref)
               SELECT $1, $2, $3, 'medium', 'github', $4
                WHERE NOT EXISTS (SELECT 1 FROM ideation_items WHERE project_slug = $1 AND external_ref = $4)
               ON CONFLICT (project_slug, external_ref) WHERE external_ref IS NOT NULL DO NOTHING RETURNING id`,
              values,
            )
          : await pool.query(
              `INSERT INTO ideation_items (project_slug, title, description, source, external_ref)
               SELECT $1, $2, $3, 'github', $4
                WHERE NOT EXISTS (SELECT 1 FROM bugs WHERE project_slug = $1 AND external_ref = $4)
               ON CONFLICT (project_slug, external_ref) WHERE external_ref IS NOT NULL DO NOTHING RETURNING id`,
              values,
            );
      created += result.rowCount ?? 0;
    }
  }
  return created;
}

/** Gemeldete Stände; `erledigt` schließt das Issue. */
export type IssueStage = 'ausgearbeitet' | 'im_sprint' | 'blockiert' | 'erledigt';

const STAGE_LABEL: Record<IssueStage, string> = {
  ausgearbeitet: 'Ausgearbeitet (Auftrag angelegt)',
  im_sprint: 'Im Sprint',
  blockiert: 'Blockiert',
  erledigt: 'Erledigt',
};

export interface TrackedRow {
  table: 'ideation_items' | 'bugs';
  id: string;
  ref: string;
  synced: string | null;
  bugStatus: string | null;
  orderStatus: string | null;
  orderTitle: string | null;
  commit: string | null;
  sprintId: string | null;
  sprintName: string | null;
  sprintStatus: string | null;
  sprintSync: string | null;
}

/** Stand eines importierten Eintrags aus Auftrag, Sprint und (bei Bugs) Bug-Status; null = noch nichts zu melden. */
export function issueStage(row: Pick<TrackedRow, 'bugStatus' | 'orderStatus' | 'sprintStatus'>): IssueStage | null {
  if (row.orderStatus === 'done' || row.bugStatus === 'fixed') return 'erledigt';
  if (!row.orderStatus || row.orderStatus === 'rejected') return null;
  if (row.orderStatus === 'blocked') return 'blockiert';
  if (row.orderStatus === 'in_progress' || ['active', 'review'].includes(row.sprintStatus ?? '')) return 'im_sprint';
  return 'ausgearbeitet';
}

/** Gebündelter Kommentar: der aktuelle Stand mit dem Weg seit der letzten Meldung und dem Verweis auf Commit oder Tag. */
export function stageComment(row: TrackedRow, stage: IssueStage): string {
  const previous = row.synced && row.synced in STAGE_LABEL ? STAGE_LABEL[row.synced as IssueStage] : null;
  const lines = [
    `**Dev Log:** ${previous ? `${previous} → ` : ''}**${STAGE_LABEL[stage]}**`,
    row.orderTitle ? `Auftrag: ${row.orderTitle}` : '',
    stage === 'im_sprint' && row.sprintName ? `Sprint: ${row.sprintName}` : '',
  ];
  if (stage === 'erledigt') {
    const tag =
      row.sprintId && row.sprintName && row.sprintStatus === 'completed' && row.sprintSync === 'done'
        ? sprintTag(row.sprintName, row.sprintId)
        : null;
    lines.push(
      tag
        ? `Umgesetzt im Tag \`${tag}\`${row.commit ? ` (Commit ${row.commit})` : ''}.`
        : row.commit
          ? `Umgesetzt mit Commit ${row.commit}${row.sprintName ? ` im Sprint „${row.sprintName}“` : ''}.`
          : 'Umgesetzt.',
      'Das Issue wird geschlossen.',
    );
  }
  return lines.filter(Boolean).join('\n\n');
}

/**
 * Meldet Statuswechsel importierter Ideen und Bugs als je einen gebündelten Kommentar ins Issue; bei „erledigt“ wird
 * das Issue geschlossen. Der gemeldete Stand wird in `github_synced_status` vermerkt (nichts doppelt).
 */
export async function reportIssueStatus(
  pool: Pool,
  project: string,
  repo: string,
  adapter: HosterAdapter,
): Promise<number> {
  const rows = (
    await pool.query<TrackedRow>(
      `SELECT 'ideation_items' AS "table", i.id, i.external_ref AS ref, i.github_synced_status AS synced,
              NULL AS "bugStatus", d.status AS "orderStatus", d.title AS "orderTitle", d.git_commit AS commit,
              s.id AS "sprintId", s.name AS "sprintName", s.status AS "sprintStatus", s.git_sync AS "sprintSync"
         FROM ideation_items i
         LEFT JOIN LATERAL (SELECT * FROM development_items WHERE ideation_id = i.id ORDER BY created_at DESC LIMIT 1) d ON TRUE
         LEFT JOIN sprints s ON s.id = d.sprint_id
        WHERE i.project_slug = $1 AND i.source = 'github' AND starts_with(i.external_ref, $2)
       UNION ALL
       SELECT 'bugs', b.id, b.external_ref, b.github_synced_status, b.status, d.status, d.title, d.git_commit,
              s.id, s.name, s.status, s.git_sync
         FROM bugs b
         LEFT JOIN development_items d ON d.bug_id = b.id
         LEFT JOIN sprints s ON s.id = d.sprint_id
        WHERE b.project_slug = $1 AND b.source = 'github' AND starts_with(b.external_ref, $2)`,
      [project, `${repo}#`],
    )
  ).rows;
  let reported = 0;
  for (const row of rows) {
    const stage = issueStage(row);
    const number = Number(row.ref.slice(repo.length + 1));
    if (!stage || stage === row.synced || !Number.isSafeInteger(number) || number <= 0) continue;
    await adapter.commentIssue(number, stageComment(row, stage));
    // Sofort vermerken: Scheitert danach das Schließen, wird der Kommentar nicht wiederholt.
    const table = row.table === 'bugs' ? 'bugs' : 'ideation_items';
    await pool.query(`UPDATE ${table} SET github_synced_status = $2 WHERE id = $1`, [row.id, stage]);
    reported += 1;
    if (stage === 'erledigt') {
      await adapter
        .closeIssue(number)
        .catch((error: unknown) =>
          console.warn(
            `[${project}] Issue ${row.ref} nicht geschlossen: ${error instanceof Error ? error.message : error}`,
          ),
        );
    }
  }
  return reported;
}

async function loadSettings(pool: Pool, project: string): Promise<GithubSettings | undefined> {
  return (
    await pool.query<GithubSettings>(
      `SELECT github_mode AS mode, git_remote AS remote, github_require_approval AS "requireApproval",
              github_synced_at AS "syncedAt", github_auth AS auth, github_auth_checked_at AS "authCheckedAt"
         FROM projects WHERE slug = $1`,
      [project],
    )
  ).rows[0];
}

/** Prüft die gh-Anmeldung und speichert das Ergebnis für die Einstellungen. */
export async function checkGithubAuth(pool: Pool, project: string, adapter: HosterAdapter): Promise<boolean> {
  const auth = await adapter.authStatus();
  await pool.query(
    `UPDATE projects SET github_auth = $2, github_auth_message = $3, github_auth_checked_at = NOW() WHERE slug = $1`,
    [project, auth.ok ? 'ok' : 'missing', auth.message],
  );
  return auth.ok;
}

/** Gibt es einen Sprint im Review mit geöffnetem Pull Request, den pollSprintReviews verfolgen muss? */
async function hasSprintReviews(pool: Pool, project: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM sprints WHERE project_slug = $1 AND status = 'review' AND pr_url IS NOT NULL LIMIT 1`,
    [project],
  );
  return rows.length > 0;
}

export interface GithubSyncResult {
  imported: number;
  reported: number;
  finished: number;
  /** Grund, warum nichts lief (Modus aus, kein GitHub-Remote, nicht angemeldet, Pause …). */
  skipped?: string;
}

/**
 * Worker-Takt der GitHub-Brücke je Projekt: Anmeldung prüfen, Issues importieren, Statuswechsel melden und Sprints im
 * Review verfolgen. Im Modus `aus` werden nur noch Sprints mit offenem Pull Request verfolgt; ohne solche (oder ohne
 * GitHub-Remote) wird kein gh-Befehl ausgeführt. Bei einem Rate-Limit
 * pausiert das Projekt bis zum nächsten Intervall.
 */
export async function syncGitHub(
  pool: Pool,
  project: string,
  cwd: string,
  execute: CommandExecutor = runCommand,
  now = new Date(),
  adapterFor: (repo: string) => HosterAdapter = (repo) => createGithubAdapter(repo, execute, cwd),
): Promise<GithubSyncResult> {
  const result: GithubSyncResult = { imported: 0, reported: 0, finished: 0 };
  const settings = await loadSettings(pool, project);
  if (!settings) return { ...result, skipped: 'Modus aus' };
  // Im Modus `aus` ruht nur der Issue-Import. Ein schon geöffneter Pull Request (Sprint im Review) wird weiter
  // verfolgt, sonst bliebe der Sprint nach dem Abschalten der Brücke für immer im Review.
  const issuesActive = settings.mode !== 'aus';
  if (!issuesActive && !(await hasSprintReviews(pool, project))) return { ...result, skipped: 'Modus aus' };
  const repo = githubRepo(settings.remote);
  if (!repo) {
    await pool.query(
      `UPDATE projects SET github_auth = NULL, github_auth_message = $2, github_auth_checked_at = NOW()
        WHERE slug = $1 AND github_auth_message IS DISTINCT FROM $2`,
      [project, 'Die GitHub-Brücke braucht ein GitHub-Repository (git_remote auf github.com).'],
    );
    return { ...result, skipped: 'kein GitHub-Remote' };
  }
  const state = runtime.get(project) ?? { pausedUntil: 0, reviewsAt: 0 };
  runtime.set(project, state);
  if (state.pausedUntil > now.getTime()) return { ...result, skipped: 'Rate-Limit-Pause' };
  const adapter = adapterFor(repo);
  const issuesDue =
    issuesActive && (!settings.syncedAt || now.getTime() - new Date(settings.syncedAt).getTime() >= ISSUE_INTERVAL_MS);
  const reviewsDue = now.getTime() - state.reviewsAt >= REVIEW_INTERVAL_MS;
  const checkedAt = settings.authCheckedAt ? new Date(settings.authCheckedAt).getTime() : 0;
  const authValid = settings.auth === 'ok' && now.getTime() - checkedAt < AUTH_RECHECK_MS;
  // Ohne Anmeldung höchstens einmal je Issue-Intervall nachfragen; „Erneut prüfen“ setzt den Zeitpunkt zurück.
  const authDue = !authValid && (settings.auth !== 'missing' || now.getTime() - checkedAt >= ISSUE_INTERVAL_MS);
  if (!authValid && !authDue) return { ...result, skipped: 'nicht angemeldet' };
  if (!issuesDue && !reviewsDue && !authDue) return { ...result, skipped: 'Intervall' };
  try {
    if (authDue && !(await checkGithubAuth(pool, project, adapter))) return { ...result, skipped: 'nicht angemeldet' };
    if (reviewsDue) {
      state.reviewsAt = now.getTime();
      result.finished = await pollSprintReviews(pool, project, cwd, adapter, settings.requireApproval, execute, () =>
        goLive(pool, project, cwd, execute),
      );
    }
    if (issuesDue) {
      const since = settings.syncedAt ? new Date(new Date(settings.syncedAt).getTime() - SINCE_OVERLAP_MS) : null;
      result.imported = await importIssues(pool, project, repo, adapter, since);
      result.reported = await reportIssueStatus(pool, project, repo, adapter);
      await pool.query(`UPDATE projects SET github_synced_at = $2 WHERE slug = $1`, [project, now]);
    }
    if (result.imported) console.info(`[${project}] ${result.imported} GitHub-Issues übernommen.`);
    return result;
  } catch (error) {
    if (error instanceof HosterError && error.rateLimited) {
      state.pausedUntil = now.getTime() + ISSUE_INTERVAL_MS;
      console.warn(`[${project}] GitHub-Rate-Limit erreicht – Pause bis zum nächsten Intervall.`);
      return { ...result, skipped: 'Rate-Limit' };
    }
    throw error;
  }
}
