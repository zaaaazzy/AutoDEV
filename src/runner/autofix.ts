import type { Pool } from 'pg';
import { reportAgentBug } from '../api/bugs.js';

const MAX_AUTO_RETRIES = 2;

interface FailedItem {
  id: string;
  projectSlug: string;
  title: string;
  kind?: string;
  bugId?: string | null;
  sprintId?: string | null;
}

/**
 * Fehler des Agents selbst (Zeitlimit, Schleife, Modell nicht erreichbar, Befehl fehlt …) sind keine Fehler im Code.
 * Ein Bug-Auftrag dafür kann nichts beheben und würde nur weitere Fehlschläge und Prompt-Ballast erzeugen.
 */
const AGENT_FAILURE_PATTERNS = [
  /Zeitlimit erreicht/,
  /Schleife erkannt/,
  /wiederholt mit denselben Argumenten/,
  /Maximale Anzahl von \d+ Schritten erreicht/,
  /Der Entwickler-Agent hat keine Dateien geändert/,
  /Ollama nicht erreichbar/,
  /Ollama antwortete mit \d+/,
  /Ollama lieferte keine Nachricht/,
  /Das Modell lieferte keine Antwort/,
  /im PATH des Workers nicht gefunden/,
  /\bENOENT\b/,
  /Process ended by SIG\w+ \(timeout or kill\)/,
  /Unterbrochen: Der Worker wurde beendet/,
];

export function isAgentFailure(output: string): boolean {
  const tail = output.slice(-1500);
  return AGENT_FAILURE_PATTERNS.some((pattern) => pattern.test(tail));
}

/**
 * Hält den Fehler am Auftrag fest, legt einen Bug-Bericht an und – bei aktivem automatischen Bugfixing –
 * erzeugt sofort einen Behebungsauftrag, der ohne Sprint-Zuweisung vom Worker aufgenommen wird.
 */
export async function registerFailure(pool: Pool, item: FailedItem, agentName: string, output: string): Promise<void> {
  const detail = output.trim().slice(-3000) || 'Keine Ausgabe vorhanden.';
  const auto =
    (
      await pool.query<{ auto: boolean }>('SELECT auto_bugfix AS auto FROM projects WHERE slug = $1', [
        item.projectSlug,
      ])
    ).rows[0]?.auto ?? true;
  if (item.bugId) {
    await pool.query('UPDATE bugs SET fix_notes = $2, updated_at = NOW() WHERE id = $1', [
      item.bugId,
      `Letzter Behebungsversuch scheiterte bei „${agentName}“: ${detail.slice(-1500)}`,
    ]);
    await pool.query(
      `UPDATE development_items SET failure = $2, failure_bug_id = $3, auto_run = FALSE,
              analysis_status = CASE WHEN $4 AND analysis_status IS NULL THEN 'requested' ELSE analysis_status END
        WHERE id = $1`,
      [item.id, `Agent „${agentName}“ scheiterte:\n\n${detail}`, item.bugId, auto],
    );
    return;
  }
  if (isAgentFailure(detail)) {
    // Kein Bug-Bericht: Auftrag bleibt blockiert, die Problemanalyse schlägt das weitere Vorgehen vor.
    await pool.query(
      `UPDATE development_items SET failure = $2, auto_run = FALSE,
              analysis_status = CASE WHEN analysis_status IS NULL THEN 'requested' ELSE analysis_status END
        WHERE id = $1`,
      [item.id, `Agent „${agentName}“ konnte nicht arbeiten (kein Code-Fehler, daher kein Bug-Auftrag):\n\n${detail}`],
    );
    return;
  }
  const bugId = await reportAgentBug(pool, {
    projectSlug: item.projectSlug,
    title: `Agent „${agentName}“ scheiterte bei „${item.title}“`,
    description: detail,
  });
  await pool.query('UPDATE development_items SET failure = $2, failure_bug_id = $3, auto_run = FALSE WHERE id = $1', [
    item.id,
    `Agent „${agentName}“ scheiterte:\n\n${detail}`,
    bugId,
  ]);
  if (auto) await queueBugFix(pool, item, bugId);
}

/** Erzeugt (einmalig) den Behebungsauftrag zu einem Bug; er läuft automatisch, auch ohne Sprint. */
export async function queueBugFix(pool: Pool, item: FailedItem, bugId: string): Promise<void> {
  await pool.query(
    `INSERT INTO development_items (project_slug, sprint_id, title, description, status, priority, kind, bug_id, auto_run)
     SELECT b.project_slug, $2, 'Bug: ' || b.title,
            'Behebe den Fehler, der den Auftrag „' || $3 || '“ blockiert. Danach wird der Auftrag automatisch erneut gestartet.' || E'\n\n' || b.description,
            'planned', 'high', 'bug', b.id, TRUE
       FROM bugs b WHERE b.id = $1
     ON CONFLICT (bug_id) WHERE bug_id IS NOT NULL DO NOTHING`,
    [bugId, item.sprintId ?? null, item.title],
  );
}

/** Nach erfolgreicher Behebung: den blockierten Ursprungsauftrag erneut einplanen (begrenzte Versuche). */
export async function resumeBlockedByBug(pool: Pool, bugId: string): Promise<void> {
  await pool.query(
    `UPDATE development_items d SET status = 'planned', auto_run = TRUE, failure = NULL, retry_count = retry_count + 1, updated_at = NOW()
      WHERE d.failure_bug_id = $1 AND d.status = 'blocked' AND d.kind <> 'bug' AND d.retry_count < $2
        AND (SELECT auto_bugfix FROM projects WHERE slug = d.project_slug)`,
    [bugId, MAX_AUTO_RETRIES],
  );
}

/** Holt bei blockierten Aufträgen ohne Bug-Bericht (ältere Fehler) den Bericht und die Behebung nach. */
export async function backfillFailures(pool: Pool, project: string): Promise<void> {
  const blocked = await pool.query<FailedItem & { agentName: string | null; output: string | null }>(
    `SELECT d.id, d.project_slug AS "projectSlug", d.title, d.kind, d.bug_id AS "bugId", d.sprint_id AS "sprintId",
            last.agent_name AS "agentName", last.output
       FROM development_items d
       LEFT JOIN LATERAL (
         SELECT st.agent_name, st.output FROM agent_run_steps st JOIN agent_runs r ON r.id = st.run_id
          WHERE r.development_id = d.id AND st.status = 'failed' ORDER BY r.started_at DESC, st.position DESC LIMIT 1
       ) last ON TRUE
      WHERE d.project_slug = $1 AND d.status = 'blocked' AND d.failure IS NULL AND d.kind <> 'bug' AND last.agent_name IS NOT NULL`,
    [project],
  );
  for (const item of blocked.rows) {
    await registerFailure(pool, item, item.agentName ?? 'Agent', item.output ?? '');
  }
}
