import { logged } from '../core/log.js';
import type { Pool } from 'pg';
import { sendPush } from '../core/push.js';
import { DEVELOPMENT_STATUS, REVIEW_MODES } from '../core/status.js';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { resumeBlockedByBug } from './autofix.js';
import { followPreview, mergeApprovedBranch, type OrderBranch } from './git-sync.js';

/**
 * Review-Freigabe: Ein fertiger Auftrag wird nicht sofort in den Sprint-Branch gemergt, sondern wartet (Status
 * „approval“), bis ein Mensch ihn in der Review-Instanz angesehen und freigegeben hat. Je Projekt einstellbar:
 * off = nie, ui = nur bei Änderungen an der Oberfläche, always = immer.
 */
export type ReviewMode = 'off' | 'ui' | 'always';

const UI_FILE =
  /\.(html|s?css|sass|less|tsx|jsx|vue|svelte|svg)$|\.component\.ts$|(^|\/)(frontend|ui|web|client|public|assets|pages|views)\//i;

/** Betrifft der Auftrag die Oberfläche? (Heuristik über die geänderten Dateien.) */
export function touchesUi(files: string[]): boolean {
  return files.some((file) => UI_FILE.test(file));
}

export function needsApproval(mode: ReviewMode, files: string[]): boolean {
  if (mode === 'always') return files.length > 0;
  if (mode === 'ui') return touchesUi(files);
  return false;
}

export async function loadReviewMode(pool: Pool, project: string): Promise<ReviewMode> {
  const result = await pool.query<{ mode: string }>('SELECT review_mode AS mode FROM projects WHERE slug = $1', [
    project,
  ]);
  const mode = result.rows[0]?.mode ?? 'off';
  return REVIEW_MODES.has(mode) ? (mode as ReviewMode) : 'off';
}

/**
 * Projektordner, der als Vorschau dem Sprint-Stand folgt: nur wenn die Agents in einem eigenen Ordner arbeiten
 * (sonst ist der Projektordner ihr Arbeitsordner).
 */
async function previewFolder(pool: Pool, project: string, cwd: string): Promise<string | null> {
  const result = await pool.query<{ repository: string; separate: boolean }>(
    'SELECT repository, agent_workspace AS separate FROM projects WHERE slug = $1',
    [project],
  );
  const row = result.rows[0];
  return row?.separate && row.repository !== cwd ? row.repository : null;
}

/** Nach einem Merge in den Sprint-Branch den Projektordner (Vorschau, z. B. dev-live) nachziehen. */
export async function followProjectPreview(
  pool: Pool,
  project: string,
  cwd: string,
  base: string,
  execute: CommandExecutor = runCommand,
): Promise<void> {
  const folder = await previewFolder(pool, project, cwd).catch(logged('review-gate', null));
  if (!folder) return;
  const message = await followPreview(folder, base, execute).catch((error: unknown) => String(error));
  if (message) console.info(`[${project}] ${message}`);
}

/** Auftrag hält vor dem Merge an: Status „Wartet auf Freigabe“, Branch und Basis merken, Bescheid geben. */
export async function holdForReview(
  pool: Pool,
  item: { id: string; projectSlug: string; title: string },
  branch: OrderBranch,
): Promise<void> {
  await pool.query(
    `UPDATE development_items SET status = '${DEVELOPMENT_STATUS.approval}', review_branch = $2, review_base = $3,
            review_since = NOW(), review_approved_at = NULL, agent_id = NULL, return_status = NULL, failure = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [item.id, branch.branch, branch.base],
  );
  await sendPush(
    pool,
    {
      title: `👀 Wartet auf Freigabe · ${item.projectSlug}`,
      body: `${item.title}\nIn der Review-Instanz ansehen und im Auftrag freigeben oder zurückweisen.`,
      url: `#development/${item.id}?project=${encodeURIComponent(item.projectSlug)}`,
      tag: `order-${item.id}`,
    },
    { project: item.projectSlug },
  );
}

interface Approved {
  id: string;
  projectSlug: string;
  title: string;
  bugId: string | null;
  branch: string | null;
  base: string | null;
}

/**
 * Freigegebene Aufträge mergen (im Arbeitsordner der Agents, zwischen zwei Aufträgen). Erfolg: erledigt und Vorschau
 * nachziehen. Scheitert der Merge (z. B. Konflikt), wird der Auftrag blockiert – wie ein Merge-Problem im normalen Lauf.
 * Liefert die Zahl der gemergten Aufträge.
 */
/** Höchstens so oft wird ein Auftrag nach einem Merge-Konflikt automatisch neu eingeplant. */
export const MAX_CONFLICT_RETRIES = 2;

export function isMergeConflict(message: string): boolean {
  return /Merge-Konflikt/.test(message);
}

/**
 * Merge-Konflikt mit der Basis: Auftrag statt „blockiert“ neu einplanen. Der nächste Lauf zieht die Basis in den
 * Auftrags-Branch nach, lässt die Konflikte stehen und der Entwickler löst sie. Liefert false, wenn die Neuversuche
 * aufgebraucht sind – dann bleibt es bei „Aktion notwendig“.
 */
export async function retryAfterConflict(
  pool: Pool,
  item: { id: string; projectSlug: string; title: string },
  message: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE development_items SET status = '${DEVELOPMENT_STATUS.planned}', auto_run = TRUE,
            conflict_retries = conflict_retries + 1, review_approved_at = NULL, action_todo = NULL, agent_id = NULL,
            return_status = NULL, failure = $3, updated_at = NOW()
      WHERE id = $1 AND conflict_retries < $2 RETURNING id`,
    [item.id, MAX_CONFLICT_RETRIES, `${message}\n\nWird automatisch neu gestartet: Der Entwickler löst die Konflikte.`],
  );
  if (!result.rowCount) return false;
  console.info(`[${item.id}] Merge-Konflikt – neu eingeplant, der Entwickler löst die Konflikte.`);
  await sendPush(
    pool,
    {
      title: `↻ Merge-Konflikt wird gelöst · ${item.projectSlug}`,
      body: `${item.title}\nDer Auftrag startet neu, der Entwickler führt die Änderungen zusammen.`,
      url: `#development/${item.id}?project=${encodeURIComponent(item.projectSlug)}`,
      tag: `order-${item.id}`,
    },
    { project: item.projectSlug },
  );
  return true;
}

export async function processApprovals(
  pool: Pool,
  project: string,
  cwd: string,
  execute: CommandExecutor = runCommand,
): Promise<number> {
  const approved = await pool.query<Approved>(
    `SELECT id, project_slug AS "projectSlug", title, bug_id AS "bugId", review_branch AS branch, review_base AS base
       FROM development_items
      WHERE project_slug = $1 AND status = '${DEVELOPMENT_STATUS.approval}' AND review_approved_at IS NOT NULL
      ORDER BY review_approved_at`,
    [project],
  );
  let merged = 0;
  for (const item of approved.rows) {
    const result =
      item.branch && item.base
        ? await mergeApprovedBranch(cwd, item, item.branch, item.base, execute)
        : { merged: false, message: 'Auftrags-Branch unbekannt – bitte erneut ausführen.' };
    console.info(`[${item.id}] ${result.message}`);
    if (!result.merged && isMergeConflict(result.message)) {
      const retried = await retryAfterConflict(pool, item, result.message).catch(logged('review-gate', false));
      if (retried) continue;
    }
    if (!result.merged) {
      await pool.query(
        `UPDATE development_items SET status = '${DEVELOPMENT_STATUS.blocked}', failure = $2, review_approved_at = NULL,
                updated_at = NOW()
          WHERE id = $1`,
        [item.id, result.message],
      );
      await sendPush(
        pool,
        {
          title: `⚠ Freigabe nicht gemergt · ${project}`,
          body: `${item.title}\n${result.message}`,
          url: `#development/${item.id}?project=${encodeURIComponent(project)}`,
        },
        { project },
      );
      continue;
    }
    merged += 1;
    await pool.query(
      `UPDATE development_items SET status = '${DEVELOPMENT_STATUS.done}', review_branch = NULL, review_base = NULL,
              review_since = NULL, updated_at = NOW()
        WHERE id = $1`,
      [item.id],
    );
    await sendPush(
      pool,
      {
        title: `✓ Auftrag freigegeben · ${project}`,
        body: item.title,
        url: `#development/${item.id}?project=${encodeURIComponent(project)}`,
        tag: `order-${item.id}`,
      },
      { project },
    );
    if (item.bugId) await resumeBlockedByBug(pool, item.bugId).catch(logged('review-gate'));
  }
  return merged;
}
