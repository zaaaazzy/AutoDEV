// Nach einem Schritt bzw. am Ende des Laufs: Ergebnisse speichern, Auftrags-Branch abschließen, Status und Push.
import type { Pool } from 'pg';
import { logged } from '../core/log.js';
import { sendPush } from '../core/push.js';
import { AGENT_STEP_STATUS, DEVELOPMENT_STATUS } from '../core/status.js';
import { saveOrderDoc, upsertDoc } from '../api/docs.js';
import { clearManualTodo, MERGE_TODO, SECRETS_TODO, setActionTodo } from './action-todo.js';
import { resumeBlockedByBug } from './autofix.js';
import { commitTaskToGit, finishOrderBranch, orderWorkInProgress } from './git-sync.js';
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
/**
 * Wurde der Auftrag während des Laufs aus seinem Sprint genommen (Sprint abgebrochen, von Hand entfernt)? Dann darf er
 * nicht mehr in den Sprint-Branch gemergt werden – der Sprint wird nie mehr gesichert, die Arbeit käme nicht in main.
 */
export async function leftItsSprint(pool: RunContext['pool'], item: RunContext['item']): Promise<boolean> {
  if (!item.sprintId) return false;
  const row = (
    await pool.query<{ sprintId: string | null }>(
      'SELECT sprint_id AS "sprintId" FROM development_items WHERE id = $1',
      [item.id],
    )
  ).rows[0];
  // Nur eine echte, geänderte Zuordnung zählt (fehlt die Spalte, wurde nichts geändert).
  return Boolean(row && 'sprintId' in row && row.sprintId !== item.sprintId);
}

export const CLEANUP_STEP = 'Arbeitsordner aufräumen (Git)';

/**
 * Aufräumen nach einer Unterbrechung gescheitert: eigener, gescheiterter Schritt am Ende des Laufs mit der Meldung.
 * Als `interrupted` markiert, damit der nächste Lauf beim unterbrochenen Agent fortsetzt (keine Nachbesserungsschleife).
 */
async function recordCleanupFailure(ctx: RunContext, message: string): Promise<void> {
  const output = `Arbeitsordner ${ctx.options.cwd} steht nach der Unterbrechung noch mit offenen Änderungen auf einem Auftrags-Branch – der nächste Auftrag kann dort nicht starten. ${message}`;
  await ctx.pool.query(
    `INSERT INTO agent_run_steps (run_id, position, agent_name, phase, status, output, interrupted)
     SELECT $1, COALESCE(MAX(position), -1) + 1, $2, 'after_task', '${AGENT_STEP_STATUS.failed}', $3, TRUE
       FROM agent_run_steps WHERE run_id = $1`,
    [ctx.runId, CLEANUP_STEP, output],
  );
  await ctx.pool.query(`UPDATE development_items SET failure = $2 WHERE id = $1`, [ctx.item.id, output]);
}

export async function settleItem(ctx: RunContext, passed: boolean, interrupted: boolean): Promise<void> {
  const { pool, item, options, execute } = ctx;
  if (await leftItsSprint(pool, item).catch(() => false)) {
    // Zwischenstand auf dem Auftrags-Branch sichern (nichts mergen); der Auftrag bleibt im Backlog bzw. unter „Aktionen“.
    if (ctx.branch) {
      const saved = await finishOrderBranch(options.cwd, item, ctx.branch, ctx.sprintName ?? '', false, execute).catch(
        (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
      );
      console.info(`[${item.id}] Aus dem Sprint genommen – ${saved.message}`);
    }
    await pool.query(
      `UPDATE development_items SET status = '${DEVELOPMENT_STATUS.backlog}', updated_at = NOW() WHERE id = $1`,
      [item.id],
    );
    return;
  }
  if (interrupted) {
    // Arbeitsordner freigeben: Zwischenstand als WIP-Commit auf dem Auftrags-Branch sichern und zur Basis zurück.
    // Sonst bliebe der Ordner (oft stundenlang, z. B. beim Nutzungslimit) auf diesem Branch stehen, und jeder andere
    // Auftrag scheiterte an „fremden Änderungen“. Der nächste Lauf setzt den Branch samt WIP fort (enterOrderBranch).
    if (ctx.branch) {
      const saved = await finishOrderBranch(options.cwd, item, ctx.branch, ctx.sprintName ?? '', false, execute).catch(
        (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
      );
      console.info(`[${item.id}] Unterbrochen – ${saved.message}`);
      // Steht der Ordner danach noch mit offenen Änderungen auf einem Auftrags-Branch, scheitert der nächste Auftrag an
      // „fremden Änderungen“: im Lauf als gescheiterten Schritt zeigen statt nur im Worker-Log.
      if (await orderWorkInProgress(options.cwd, execute).catch(() => false)) {
        await recordCleanupFailure(ctx, saved.message).catch(logged('runner-settle'));
      }
    }
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
  let secretsHeld = false;
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
    secretsHeld = Boolean(result.secrets?.length);
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
    // Kein Konflikt (die gehen oben in einen neuen Versuch): Ohne Vermerk wartete der Sprint still auf eine Behebung,
    // die niemand startet – sichtbar machen, was zu tun ist.
    if (!isMergeConflict(mergeProblem)) {
      await setActionTodo(pool, item.id, secretsHeld ? SECRETS_TODO : MERGE_TODO).catch(logged('runner-steps'));
    }
  } else if (!succeeded) {
    await clearManualTodo(pool, item.id).catch(logged('runner-steps'));
  }
  if (item.agentId) {
    // A one-agent play restores the previous status; a blocked order resumes normally after success.
    await pool.query(
      `UPDATE development_items SET agent_id = NULL, return_status = NULL, updated_at = NOW(),
              status = CASE WHEN status IN ('${DEVELOPMENT_STATUS.rejected}', '${DEVELOPMENT_STATUS.backlog}') THEN status WHEN NOT $2 THEN '${DEVELOPMENT_STATUS.blocked}' WHEN return_status IS NULL OR return_status = '${DEVELOPMENT_STATUS.blocked}' THEN '${DEVELOPMENT_STATUS.planned}' ELSE return_status END
        WHERE id = $1`,
      [item.id, succeeded],
    );
    await notifySettled(pool, item, succeeded, mergeProblem ?? ctx.stopReason ?? null);
    return;
  }
  // „Abgelehnt“ (Projektregel, gesetzt in registerFailure) bleibt stehen statt „Blockiert“. „Backlog“ ebenso: der
  // Sprint wurde währenddessen abgebrochen (cancelSprint), der Auftrag bleibt draußen und wartet unter „Aktionen“.
  await pool.query(
    `UPDATE development_items SET agent_id = NULL, return_status = NULL, updated_at = NOW(),
            status = CASE WHEN status IN ('${DEVELOPMENT_STATUS.rejected}', '${DEVELOPMENT_STATUS.backlog}') THEN status ELSE $2 END WHERE id = $1`,
    [item.id, succeeded ? DEVELOPMENT_STATUS.done : DEVELOPMENT_STATUS.blocked],
  );
  await notifySettled(pool, item, succeeded, mergeProblem ?? ctx.stopReason ?? null);
  if (!succeeded) return;
  if (item.bugId) await resumeBlockedByBug(pool, item.bugId).catch(logged('runner-steps'));
}
