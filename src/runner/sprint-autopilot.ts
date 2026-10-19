import type { Pool } from 'pg';
import { applyProposal, autopilotGuard, loadProposal } from '../api/sprint-planning.js';
import { sendPush } from '../core/push.js';

export type AutopilotStep =
  'off' | 'paused' | 'working' | 'review' | 'completed' | 'started' | 'outside_hours' | 'idle';

/**
 * Offen = noch zu bearbeiten. Blockierte Aufträge halten den Sprint nur dann nicht auf, wenn sie „Aktion notwendig“
 * haben (warten auf einen Menschen); andere Blockierte sind Fehler, die noch behoben werden.
 */
export function sprintSettled(items: { status: string; actionTodo: string | null }[]): boolean {
  return (
    items.length > 0 &&
    !items.some(
      (item) =>
        // Wartet ein Auftrag auf die Review-Freigabe, ist er noch nicht im Sprint-Branch: der Sprint wartet mit.
        ['backlog', 'planned', 'in_progress', 'approval'].includes(item.status) ||
        (item.status === 'blocked' && !item.actionTodo),
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
      url: '#sprints',
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
    await pool.query<{ status: string; actionTodo: string | null }>(
      `SELECT status, action_todo AS "actionTodo" FROM development_items
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
        url: '#sprints',
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
      await notifyPause(pool, project, guard.failedSprintId, guard.message ?? '').catch(() => undefined);
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
      await pool.query<{ status: string; actionTodo: string | null }>(
        // Express-Anfragen sind ungeplant: Eine offene Rückfrage im Chat hält den Sprintabschluss nicht auf.
        `SELECT status, action_todo AS "actionTodo" FROM development_items
          WHERE sprint_id = $1 AND status <> 'rejected' AND kind <> 'express'`,
        [active.id],
      )
    ).rows;
    if (!sprintSettled(items)) return 'working';
    // Alles erledigt: Der Sprint wartet auf das Go (Vorschau ansehen, „Live schalten“) – der Autopilot schaltet nie
    // selbst live und startet den nächsten Sprint erst danach.
    return 'review';
  }

  if (guard.state === 'outside_hours') return 'outside_hours';
  const proposal = await loadProposal(pool, project);
  const selected = proposal?.items.filter((item) => item.selected) ?? [];
  // Nur übernommene „Aktion notwendig“-Aufträge: kein neuer Sprint, sonst würde er sofort wieder abgeschlossen.
  if (!proposal || !selected.some((item) => !item.carryOver)) return 'idle';
  const ids = [...selected].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).map((item) => item.id);
  const result = await applyProposal(pool, project, ids, true);
  if (typeof result === 'string') return 'idle';
  await sendPush(
    pool,
    {
      title: `▶ Sprint gestartet · ${project}`,
      body: `${proposal.name}: ${ids.length} Aufträge (${proposal.totals.hours} h) vom Autopilot eingeplant.`,
      url: '#sprints',
      tag: `autopilot-${project}`,
    },
    { project: project },
  );
  return 'started';
}
