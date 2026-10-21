// Nach einem Schritt bzw. am Ende des Laufs: Ergebnisse speichern, Auftrags-Branch abschließen, Status und Push.
import type { Pool } from 'pg';
import { logged } from '../core/log.js';
import { sendPush } from '../core/push.js';
import { DEVELOPMENT_STATUS } from '../core/status.js';
import { saveOrderDoc, upsertDoc } from '../api/docs.js';
import { resumeBlockedByBug } from './autofix.js';
import { commitTaskToGit, finishOrderBranch } from './git-sync.js';
import {
  holdForReview,
  isMergeConflict,
  loadReviewMode,
  needsApproval,
  retryAfterConflict,
  type ReviewMode,
} from './review-gate.js';
import type { RunContext } from './runner-context.js';
import type { WorkflowAgent, WorkItem } from './runner-types.js';

export const MANUAL_TITLE = 'Anwendungshandbuch';
export const USER_MANUAL_TITLE = 'Benutzerhandbuch';
const MIN_MANUAL_CHARS = 200;

export async function afterStep(pool: Pool, item: WorkItem, agent: WorkflowAgent, output: string): Promise<void> {
  if (agent.role === 'documenter' && output.trim()) {
    await saveOrderDoc(pool, {
      projectSlug: item.projectSlug,
      developmentId: item.id,
      title: item.title,
      content: output,
    });
  } else if (agent.role === 'manual_writer' && output.trim().length >= MIN_MANUAL_CHARS) {
    await upsertDoc(pool, { projectSlug: item.projectSlug, kind: 'manual', title: MANUAL_TITLE, content: output });
  } else if (agent.role === 'user_manual_writer' && output.trim().length >= MIN_MANUAL_CHARS) {
    await upsertDoc(pool, { projectSlug: item.projectSlug, kind: 'manual', title: USER_MANUAL_TITLE, content: output });
  } else if (agent.role === 'developer' && item.bugId) {
    await pool.query('UPDATE bugs SET fix_notes = $2, updated_at = NOW() WHERE id = $1', [
      item.bugId,
      output.trim().slice(-1500),
    ]);
  }
}

/** Push-Nachricht aufs Handy, wenn ein Auftrag fertig ist oder hängen bleibt. */
async function notifySettled(pool: Pool, item: WorkItem, succeeded: boolean, problem: string | null): Promise<void> {
  await sendPush(
    pool,
    {
      title: succeeded ? `✓ Auftrag erledigt · ${item.projectSlug}` : `⚠ Auftrag blockiert · ${item.projectSlug}`,
      body: succeeded ? item.title : `${item.title}\n${problem ?? 'Ein Agent ist gescheitert – Details im Auftrag.'}`,
      url: `#development/${item.id}?project=${encodeURIComponent(item.projectSlug)}`,
      tag: `order-${item.id}`,
    },
    { project: item.projectSlug },
  );
}

/** Settle the order status and trigger follow-up actions such as commits or bugfix retries. */
export async function settleItem(ctx: RunContext, passed: boolean, interrupted: boolean): Promise<void> {
  const { pool, item, options, execute } = ctx;
  if (interrupted) {
    // Return interrupted orders to planned while retaining their assignment so they can resume after restart.
    await pool.query(
      `UPDATE development_items SET status = '${DEVELOPMENT_STATUS.planned}', updated_at = NOW() WHERE id = $1`,
      [item.id],
    );
    return;
  }
  // Auftrags-Branch abschließen: bei Erfolg in den Sprint-/Basis-Branch mergen, sonst Zwischenstand sichern.
  let mergeProblem: string | null = null;
  let commit: string | null = null;
  if (ctx.branch) {
    // Review-Freigabe (Projekteinstellung): nur ganze Abläufe, nicht das Ausführen eines einzelnen Agents.
    const review =
      passed && !item.agentId ? await loadReviewMode(pool, item.projectSlug).catch((): ReviewMode => 'off') : 'off';
    const hold = review === 'off' ? undefined : (files: string[]) => needsApproval(review, files);
    const result = await finishOrderBranch(options.cwd, item, ctx.branch, ctx.sprintName ?? '', passed, execute, hold);
    console.info(`[${item.id}] ${result.message}`);
    if (result.held) {
      await holdForReview(pool, item, ctx.branch);
      return;
    }
    if (passed && !result.merged) mergeProblem = result.message;
    commit = result.commit;
  } else if (passed && ctx.sprintName) {
    commit = await commitTaskToGit(options.cwd, item, ctx.sprintName, execute);
  }
  if (commit) {
    // Verweis für die GitHub-Rückmeldung (Issue schließen mit Commit). Nur ein Zusatz: Fehlt er, nennt der
    // Kommentar keinen Commit – der Abschluss des Auftrags darf daran nicht scheitern.
    await pool
      .query(`UPDATE development_items SET git_commit = $2 WHERE id = $1`, [item.id, commit])
      .catch((error: unknown) => console.warn(`[${item.id}] Commit-Verweis nicht gespeichert: ${String(error)}`));
  }
  // Merge-Konflikt mit der Basis: automatisch neu einplanen; der nächste Lauf zieht die Basis nach und der Entwickler
  // löst die Konflikte (höchstens zweimal, danach „Aktion notwendig“ wie bisher).
  if (mergeProblem && isMergeConflict(mergeProblem) && !item.agentId) {
    if (await retryAfterConflict(pool, item, mergeProblem).catch(logged('runner-steps', false))) return;
  }
  const succeeded = passed && !mergeProblem;
  if (mergeProblem) {
    await pool
      .query(`UPDATE development_items SET failure = $2 WHERE id = $1`, [item.id, mergeProblem])
      .catch(logged('runner-steps'));
  }
  if (item.agentId) {
    // A one-agent play restores the previous status; a blocked order resumes normally after success.
    await pool.query(
      `UPDATE development_items SET agent_id = NULL, return_status = NULL, updated_at = NOW(),
              status = CASE WHEN status = '${DEVELOPMENT_STATUS.rejected}' THEN status WHEN NOT $2 THEN '${DEVELOPMENT_STATUS.blocked}' WHEN return_status IS NULL OR return_status = '${DEVELOPMENT_STATUS.blocked}' THEN '${DEVELOPMENT_STATUS.planned}' ELSE return_status END
        WHERE id = $1`,
      [item.id, succeeded],
    );
    await notifySettled(pool, item, succeeded, mergeProblem ?? ctx.stopReason ?? null);
    return;
  }
  // „Abgelehnt“ (Projektregel, gesetzt in registerFailure) bleibt stehen statt „Blockiert“.
  await pool.query(
    `UPDATE development_items SET agent_id = NULL, return_status = NULL, updated_at = NOW(),
            status = CASE WHEN status = '${DEVELOPMENT_STATUS.rejected}' THEN status ELSE $2 END WHERE id = $1`,
    [item.id, succeeded ? DEVELOPMENT_STATUS.done : DEVELOPMENT_STATUS.blocked],
  );
  await notifySettled(pool, item, succeeded, mergeProblem ?? ctx.stopReason ?? null);
  if (!succeeded) return;
  if (item.bugId) await resumeBlockedByBug(pool, item.bugId).catch(logged('runner-steps'));
}
