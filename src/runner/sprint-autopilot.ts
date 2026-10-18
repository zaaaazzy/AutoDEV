import type { Pool } from 'pg';
import { applyProposal, completeSprint, loadProposal } from '../api/sprint-planning.js';
import { sendPush } from '../core/push.js';

export type AutopilotStep = 'off' | 'paused' | 'working' | 'completed' | 'started' | 'idle';

/** Offen = noch zu bearbeiten; „Aktion notwendig“ (blockiert) wartet auf einen Menschen und hält den Sprint nicht auf. */
export function sprintSettled(statuses: string[]): boolean {
  return statuses.length > 0 && !statuses.some((status) => ['backlog', 'planned', 'in_progress'].includes(status));
}

/**
 * Autopilot je Projekt (am Anfang jedes Worker-Zyklus): Ist im laufenden Sprint nichts mehr zu tun, wird er
 * abgeschlossen; danach wird der nächste Sprint vorgeschlagen, übernommen und gestartet. Offene „Aktion
 * notwendig“-Aufträge wandern dabei mit. Scheiterte die Git-Sicherung des letzten Sprints, pausiert der Autopilot.
 */
export async function sprintAutopilot(pool: Pool, project: string): Promise<AutopilotStep> {
  const mode = (
    await pool.query<{ mode: string }>('SELECT sprint_mode AS mode FROM projects WHERE slug = $1', [project])
  ).rows[0]?.mode;
  if (mode !== 'autopilot') return 'off';
  const lastSync = (
    await pool.query<{ sync: string | null }>(
      `SELECT git_sync AS sync FROM sprints WHERE project_slug = $1 AND status = 'completed'
        ORDER BY COALESCE(end_date, created_at::date) DESC, created_at DESC LIMIT 1`,
      [project],
    )
  ).rows[0]?.sync;
  if (lastSync === 'failed') return 'paused';
  // Abschluss läuft noch (Test-Gate, Merge, Push): erst danach den nächsten Sprint starten.
  if (lastSync === 'pending' || lastSync === 'running') return 'working';

  const active = (
    await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM sprints WHERE project_slug = $1 AND status = 'active'`,
      [project],
    )
  ).rows[0];
  if (active) {
    const statuses = (
      await pool.query<{ status: string }>(
        `SELECT status FROM development_items WHERE sprint_id = $1 AND status <> 'rejected'`,
        [active.id],
      )
    ).rows.map((row) => row.status);
    if (!sprintSettled(statuses)) return 'working';
    await completeSprint(pool, active.id);
    await sendPush(
      pool,
      {
        title: `🏁 Sprint abgeschlossen · ${project}`,
        body: `${active.name} wurde vom Autopilot abgeschlossen.`,
        url: '#sprints',
        tag: `autopilot-${project}`,
      },
      { project: project },
    );
    return 'completed';
  }

  const proposal = await loadProposal(pool, project);
  const selected = proposal?.items.filter((item) => item.selected) ?? [];
  // Nur übernommene „Aktion notwendig“-Aufträge: kein neuer Sprint, sonst würde er sofort wieder abgeschlossen.
  const workable = selected.some((item) => !item.reason.includes('aus dem vorigen Sprint übernommen'));
  if (!proposal || !workable) return 'idle';
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
