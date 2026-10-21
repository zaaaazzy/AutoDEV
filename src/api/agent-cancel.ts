import type { Pool } from 'pg';

/** Ohne Lebenszeichen seit so vielen Sekunden gilt der Worker als offline (wie in der Worker-Anzeige). */
const WORKER_ONLINE_SECONDS = 60;

export const ORPHAN_CANCEL_NOTE =
  'Vom Benutzer abgebrochen. Der Worker, der diesen Agent gestartet hatte, lief nicht mehr – der Schritt wurde direkt beendet.';

/**
 * Laufenden Agent abbrechen. Normalerweise setzt das nur cancel_requested; der Worker sieht die Markierung binnen
 * Sekunden, beendet den Agent-Prozess und schließt den Schritt ab. Läuft der Worker, der den Schritt gestartet hat,
 * nicht mehr (offline oder seither neu gestartet), wartet niemand auf die Markierung: Solche verwaisten Schritte
 * schließt der Abbruch selbst ab (Schritt und Lauf gescheitert, Auftrag blockiert). Einen übrig gebliebenen
 * Agent-Prozess beendet der Worker bei seinem nächsten Start.
 */
export async function cancelAgent(
  pool: Pool,
  slug: string,
  agentId: string,
): Promise<{ requested: number; closed: number }> {
  const requested = await pool.query(
    `UPDATE agent_run_steps st SET cancel_requested = TRUE
       FROM agent_runs r, agents a
      WHERE r.id = st.run_id AND a.id = st.agent_id AND a.project_slug = $1 AND a.id::text = $2
        AND st.status = 'running' AND r.status = 'running'`,
    [slug, agentId],
  );
  if (!requested.rowCount) return { requested: 0, closed: 0 };
  const closed = await pool.query<{ count: number }>(
    `WITH orphan AS (
       SELECT st.id AS step_id, r.id AS run_id, r.development_id
         FROM agent_run_steps st
         JOIN agent_runs r ON r.id = st.run_id
         JOIN agents a ON a.id = st.agent_id
         LEFT JOIN worker_heartbeats h ON h.project_slug = a.project_slug
        WHERE a.project_slug = $1 AND a.id::text = $2 AND st.status = 'running' AND r.status = 'running'
          AND (h.last_seen IS NULL OR h.last_seen < NOW() - make_interval(secs => $3)
               OR h.started_at > COALESCE(st.started_at, r.started_at))
     ), steps AS (
       UPDATE agent_run_steps SET status = 'failed', exit_code = 130,
              output = COALESCE(NULLIF(output, '') || E'\\n', '') || $4
        WHERE id IN (SELECT step_id FROM orphan) RETURNING id
     ), runs AS (
       UPDATE agent_runs SET status = 'failed', completed_at = NOW()
        WHERE id IN (SELECT run_id FROM orphan) RETURNING id
     ), items AS (
       UPDATE development_items SET status = 'blocked', failure = COALESCE(failure, $4), updated_at = NOW()
        WHERE id IN (SELECT development_id FROM orphan) AND status = 'in_progress' RETURNING id
     )
     SELECT (SELECT count(*) FROM steps)::int AS count`,
    [slug, agentId, WORKER_ONLINE_SECONDS, ORPHAN_CANCEL_NOTE],
  );
  return { requested: requested.rowCount, closed: closed.rows[0]?.count ?? 0 };
}
