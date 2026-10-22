import type { Pool } from 'pg';
import { sendPush } from '../core/push.js';
import type { WorkItem } from './runner-types.js';

/** So lange wartet ein Auftrag ohne Sprint, bevor er nach einem Ordnerproblem erneut versucht wird. */
export const FOLDER_RETRY_MINUTES = 10;

/** Kennzeichen pausierter Sprints, die AIdeation selbst wegen des Arbeitsordners angehalten hat. */
export const FOLDER_PAUSE_BY = 'AIdeation (Arbeitsordner nicht sauber)';

/**
 * Der Arbeitsordner ist für jeden Auftrag unbrauchbar (fremde Änderungen, falscher Branch). Statt Auftrag um Auftrag zu
 * blockieren: diesen Auftrag zurückstellen und seinen Sprint pausieren, mit genau einer Push-Nachricht. Weiter geht es
 * mit „Fortsetzen“, sobald der Ordner sauber ist (Dashboard: Git-Hinweis mit Lösungen). Liefert, ob neu pausiert wurde.
 */
export async function pauseForFolderProblem(
  pool: Pool,
  item: Pick<WorkItem, 'id' | 'projectSlug' | 'sprintId'>,
  message: string,
): Promise<boolean> {
  await pool.query(
    `UPDATE development_items SET retry_after = NOW() + make_interval(mins => $2), updated_at = NOW() WHERE id = $1`,
    [item.id, FOLDER_RETRY_MINUTES],
  );
  if (!item.sprintId) return false;
  const paused = await pool.query<{ name: string }>(
    `UPDATE sprints SET paused_at = NOW(), paused_by = $2
      WHERE id = $1 AND status = 'active' AND paused_at IS NULL RETURNING name`,
    [item.sprintId, FOLDER_PAUSE_BY],
  );
  const sprint = paused.rows[0];
  if (!sprint) return false;
  console.warn(`[${item.projectSlug}] „${sprint.name}“ pausiert: ${message}`);
  await sendPush(
    pool,
    {
      title: `⏸ ${sprint.name} pausiert · ${item.projectSlug}`,
      body: `Der Arbeitsordner der Agents ist nicht sauber – kein Auftrag kann starten.\n${message.slice(0, 220)}\nIm Dashboard aufräumen, dann „Fortsetzen“.`,
      url: `#dashboard?project=${encodeURIComponent(item.projectSlug)}`,
      tag: `folder-pause-${item.projectSlug}`,
    },
    { project: item.projectSlug },
  );
  return true;
}
