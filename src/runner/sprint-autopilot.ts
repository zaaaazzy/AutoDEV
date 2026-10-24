import { logged } from '../core/log.js';
import type { Pool } from 'pg';
import { applyProposal, autopilotGuard, completeSprintIn, loadProposal } from '../api/sprint-planning.js';
import { sendPush } from '../core/push.js';
import { loadGitState, problemsFor } from '../api/git-state.js';
import { ENVIRONMENT_TODO } from './autofix.js';

export type AutopilotStep =
  'off' | 'paused' | 'working' | 'review' | 'completed' | 'started' | 'outside_hours' | 'idle';

/**
 * „Aktion notwendig“, die nichts mit dem Auftrag zu tun hat, sondern mit der Umgebung (Arbeitsordner, Laufwerk): Der
 * Auftrag ist nicht bearbeitet, nur aufgehalten. Ältere Läufe setzten den Git-Hinweis noch je Auftrag.
 */
export const GIT_FOLDER_TODO = 'Arbeitsordner aufräumen (Git)';
const ENVIRONMENT_TODOS = [GIT_FOLDER_TODO, ENVIRONMENT_TODO];

/**
 * Offen = noch zu bearbeiten. Blockierte Aufträge halten den Sprint nur dann nicht auf, wenn sie „Aktion notwendig“
 * haben (warten auf einen Menschen); andere Blockierte sind Fehler, die noch behoben werden. Wegen Budget blockierte
 * Aufträge (budget_blocked) laufen von selbst weiter, sobald das Budget wieder reicht: Sie sind noch offen. Ebenso
 * Aufträge, die nur an der Umgebung scheiterten (Sprint 20 galt sonst mit 18 von 20 so blockierten als „fertig“).
 */
export function sprintSettled(
  items: { status: string; actionTodo: string | null; budgetBlocked?: string | null }[],
): boolean {
  return (
    items.length > 0 &&
    !items.some(
      (item) =>
        // Wartet ein Auftrag auf die Review-Freigabe, ist er noch nicht im Sprint-Branch: der Sprint wartet mit.
        ['backlog', 'planned', 'in_progress', 'approval'].includes(item.status) ||
        (item.status === 'blocked' &&
          (!item.actionTodo ||
            // Tages- und Sprint-Budget geben von selbst wieder frei; das Budget je Auftrag nie (nur „Erneut versuchen“
            // setzt es zurück) – dieser Auftrag wartet also auf einen Menschen und hält den Sprint nicht ewig offen.
            (Boolean(item.budgetBlocked) && item.budgetBlocked !== 'order') ||
            ENVIRONMENT_TODOS.includes(item.actionTodo))),
    )
  );
}

/** Meldet eine Pause nur einmal je gescheitertem Sprint (der Worker prüft alle 30 s). */
async function notifyPause(pool: Pool, project: string, sprintId: string, message: string): Promise<void> {
  const key = `autopilot_paused:${project}`;
  const fresh = (
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE app_settings.value IS DISTINCT FROM EXCLUDED.value
       RETURNING key`,
      [key, sprintId],
    )
  ).rows[0];
  if (!fresh) return;
  await sendPush(
    pool,
    {
      title: `⏸ Autopilot pausiert · ${project}`,
      body: message.slice(0, 200),
      url: `#sprints?project=${encodeURIComponent(project)}`,
      tag: `autopilot-${project}`,
    },
    { project },
  );
}

/**
 * Sprint-Review: Sind alle Aufträge des laufenden Sprints erledigt (bzw. warten nur noch auf einen Menschen), wartet
 * der Sprint auf das Go. Einmal Bescheid geben; kommt wieder Arbeit dazu, gilt er wieder als offen.
 */
export async function markSprintReady(pool: Pool, project: string): Promise<boolean> {
  const active = (
    await pool.query<{ id: string; name: string; ready: boolean }>(
      `SELECT id, name, review_ready_at IS NOT NULL AS ready FROM sprints WHERE project_slug = $1 AND status = 'active'`,
      [project],
    )
  ).rows[0];
  if (!active) return false;
  const items = (
    await pool.query<{ status: string; actionTodo: string | null; budgetBlocked: string | null }>(
      `SELECT status, action_todo AS "actionTodo", budget_blocked AS "budgetBlocked" FROM development_items
        WHERE sprint_id = $1 AND status <> 'rejected' AND kind <> 'express'`,
      [active.id],
    )
  ).rows;
  const settled = sprintSettled(items);
  if (settled && !active.ready) {
    await pool.query(`UPDATE sprints SET review_ready_at = NOW() WHERE id = $1`, [active.id]);
    await sendPush(
      pool,
      {
        title: `🚀 Sprint fertig · ${project}`,
        body: `${active.name}: Alle Aufträge sind durch. Vorschau ansehen und „Live schalten“.`,
        url: `#sprints?project=${encodeURIComponent(project)}`,
        tag: `sprint-ready-${active.id}`,
      },
      { project },
    );
  } else if (!settled && active.ready) {
    await pool.query(`UPDATE sprints SET review_ready_at = NULL WHERE id = $1`, [active.id]);
  }
  return settled;
}

/**
 * Fertigen Sprint selbst live schalten. Nur aus „aktiv“, nicht pausiert (eine Pause ist eine Entscheidung eines
 * Menschen) und ohne laufenden Auftrag – dieselben Bedingungen wie „Live schalten“ in der Oberfläche.
 */
async function goLiveAutomatically(
  pool: Pool,
  project: string,
  sprint: { id: string; name: string },
): Promise<boolean> {
  // Wie in der Oberfläche: nicht live schalten, solange der Projektordner einen sperrenden Git-Befund hat.
  const { state, stale } = await loadGitState(pool, project);
  const problems = stale ? [] : problemsFor(state, 'go_live');
  if (problems.length) {
    console.info(
      `[${project}] Autopilot schaltet „${sprint.name}“ nicht live: ${problems.map((p) => p.title).join(' · ')}`,
    );
    return false;
  }
  // Status setzen und Abschluss (Bericht, Git-Sicherung) in einer Transaktion: scheitert der Abschluss, bleibt der
  // Sprint aktiv statt „abgeschlossen ohne Bericht“.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claimed = await client.query(
      `UPDATE sprints s SET status = 'completed'
        WHERE s.id = $1 AND s.status = 'active' AND s.paused_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM development_items d WHERE d.sprint_id = s.id AND d.status = 'in_progress')
        RETURNING s.id`,
      [sprint.id],
    );
    if (!claimed.rows[0]) {
      await client.query('ROLLBACK');
      return false;
    }
    await completeSprintIn(client, sprint.id);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  console.info(`[${project}] Autopilot: „${sprint.name}“ fertig – wird live geschaltet (Test-Gate, Merge, Push).`);
  await sendPush(
    pool,
    {
      title: `🚀 Sprint wird live geschaltet · ${project}`,
      body: `${sprint.name}: Alle Aufträge sind durch. Der Autopilot schaltet live (Test-Gate, Merge nach main, Push).`,
      url: `#sprints?project=${encodeURIComponent(project)}`,
      tag: `sprint-ready-${sprint.id}`,
    },
    { project },
  ).catch(logged('sprint-autopilot'));
  return true;
}

/**
 * Autopilot je Projekt (am Anfang jedes Worker-Zyklus): Ist im laufenden Sprint nichts mehr zu tun, wartet er
 * auf das Go („Live schalten“); erst danach wird – nur innerhalb der Arbeitszeiten – der nächste Sprint vorgeschlagen, übernommen und
 * gestartet. Offene „Aktion notwendig“-Aufträge wandern dabei mit. Scheitert der Abschluss (Merge/Git), pausiert
 * der Autopilot bis zur manuellen Freigabe.
 */
export async function sprintAutopilot(pool: Pool, project: string, now = new Date()): Promise<AutopilotStep> {
  const guard = await autopilotGuard(pool, project, now);
  if (!guard || guard.state === 'off') return 'off';
  if (guard.state === 'paused') {
    if (guard.failedSprintId)
      await notifyPause(pool, project, guard.failedSprintId, guard.message ?? '').catch(logged('sprint-autopilot'));
    return 'paused';
  }
  // Abschluss läuft noch (Test-Gate, Merge, Push): erst danach den nächsten Sprint starten.
  if (guard.state === 'finishing') return 'working';

  const active = (
    await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM sprints WHERE project_slug = $1 AND status = 'active'`,
      [project],
    )
  ).rows[0];
  if (active) {
    const items = (
      await pool.query<{ status: string; actionTodo: string | null; budgetBlocked: string | null }>(
        // Express-Anfragen sind ungeplant: Eine offene Rückfrage im Chat hält den Sprintabschluss nicht auf.
        `SELECT status, action_todo AS "actionTodo", budget_blocked AS "budgetBlocked" FROM development_items
          WHERE sprint_id = $1 AND status <> 'rejected' AND kind <> 'express'`,
        [active.id],
      )
    ).rows;
    if (!sprintSettled(items)) return 'working';
    // Alles erledigt. Mit „Autopilot schaltet selbst live“ (innerhalb der Arbeitszeiten) schliesst er den Sprint wie
    // „Live schalten“ ab: Bericht, dann Test-Gate, Merge nach main und Push durch die Git-Sicherung. Scheitert sie,
    // pausiert der Autopilot wie bisher. Sonst wartet der Sprint auf das Go (Vorschau ansehen, „Live schalten“).
    if (guard.autoLive && guard.state !== 'outside_hours' && (await goLiveAutomatically(pool, project, active))) {
      return 'completed';
    }
    return 'review';
  }

  if (guard.state === 'outside_hours') return 'outside_hours';
  const proposal = await loadProposal(pool, project);
  const selected = proposal?.items.filter((item) => item.selected) ?? [];
  // Nur übernommene „Aktion notwendig“-Aufträge: kein neuer Sprint, sonst würde er sofort wieder abgeschlossen.
  if (!proposal || !selected.some((item) => !item.carryOver)) return 'idle';
  const ids = [...selected].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).map((item) => item.id);
  // Kein neuer Sprint, solange der Agent-Ordner fremde Änderungen oder Branches hat: Jeder Auftrag würde blockieren.
  const git = await loadGitState(pool, project);
  if (!git.stale && problemsFor(git.state, 'sprint_start').length) return 'idle';
  const result = await applyProposal(pool, project, ids, true);
  if (typeof result === 'string') return 'idle';
  await sendPush(
    pool,
    {
      title: `▶ Sprint gestartet · ${project}`,
      body: `${proposal.name}: ${ids.length} Aufträge (${proposal.totals.hours} h) vom Autopilot eingeplant.`,
      url: `#sprints?project=${encodeURIComponent(project)}`,
      tag: `autopilot-${project}`,
    },
    { project: project },
  );
  return 'started';
}
