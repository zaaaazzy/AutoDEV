import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { DEMO_SLUG, seedDemoProject } from '../../e2e/demo/seed.js';
import { defined } from '../../src/core/defined.js';

/** Ordner des Beispielprojekts im Projektbereich; er bleibt leer, das Projekt besteht nur aus Daten. */
export const DEMO_FOLDER = 'velowerk-beispiel';

/**
 * Hält das Beispielprojekt an, damit ein echter Worker daran nichts tut: Die Testdaten zeigen einen Moment mitten
 * im Sprint (ein Agent läuft, eine Idee wird ausgearbeitet). Auf einer echten Installation würde der Worker das beim
 * Start wieder aufnehmen und dafür Tokens verbrauchen. Deshalb: Sprint pausieren, laufende Zustände abschliessen und
 * nichts nach aussen schicken (keine Health-Prüfung einer fremden Domain, kein Git-Remote, kein Log-Scan).
 */
export async function freezeDemoProject(pool: Pool, slug = DEMO_SLUG): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE projects SET health_url = NULL, git_remote = NULL, log_services = '{}' WHERE slug = $1`,
      [slug],
    );
    await client.query(
      `UPDATE sprints SET paused_at = NOW() WHERE project_slug = $1 AND status = 'active' AND paused_at IS NULL`,
      [slug],
    );
    await client.query(
      `UPDATE agent_run_steps
          SET status = 'failed', progress = NULL,
              output = output || E'\\n\\n(Beispieldaten: bei der Installation angehalten.)'
        WHERE status = 'running' AND run_id IN (SELECT id FROM agent_runs WHERE project_slug = $1)`,
      [slug],
    );
    await client.query(
      `UPDATE agent_runs SET status = 'failed', completed_at = NOW() WHERE project_slug = $1 AND status = 'running'`,
      [slug],
    );
    await client.query(
      `UPDATE development_items SET status = 'planned', updated_at = NOW()
        WHERE project_slug = $1 AND status = 'in_progress'`,
      [slug],
    );
    await client.query(
      `UPDATE development_items SET agent_id = NULL, auto_run = FALSE WHERE project_slug = $1 AND status = 'planned'`,
      [slug],
    );
    await client.query(
      `UPDATE development_items SET analysis_status = 'done'
        WHERE project_slug = $1 AND analysis_status IN ('requested', 'running')`,
      [slug],
    );
    await client.query(
      `UPDATE ideation_items SET status = 'idea', updated_at = NOW()
        WHERE project_slug = $1 AND status IN ('requested', 'drafting')`,
      [slug],
    );
    await client.query(
      `UPDATE acceptance_checks SET status = 'open'
        WHERE status IN ('verifying', 'checking')
          AND development_id IN (SELECT id FROM development_items WHERE project_slug = $1)`,
      [slug],
    );
    await client.query(
      `UPDATE chat_messages SET status = 'done' WHERE project_slug = $1 AND status IN ('pending', 'processing')`,
      [slug],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Beispielprojekt „Velowerk“ in eine frisch eingerichtete Installation laden (Wahl im Einrichtungs-Assistenten).
 * Gibt es das Projekt schon (Assistent erneut geöffnet), bleibt alles, wie es ist.
 */
export async function installDemoProject(
  pool: Pool,
  projectRoot: string,
  log: (line: string) => void,
): Promise<'created' | 'exists'> {
  const exists = await pool.query('SELECT 1 FROM projects WHERE slug = $1', [DEMO_SLUG]);
  if (exists.rowCount) {
    log('Das Beispielprojekt „Velowerk“ ist schon vorhanden – nichts geändert.');
    return 'exists';
  }
  const folder = join(projectRoot, DEMO_FOLDER);
  await mkdir(folder, { recursive: true });
  log(`Lege das Beispielprojekt „Velowerk“ an (Ordner ${folder}) …`);
  await seedDemoProject(pool, folder);
  await freezeDemoProject(pool);
  const counts = defined(
    (
      await pool.query<{ sprints: string; orders: string; bugs: string }>(
        `SELECT (SELECT count(*) FROM sprints WHERE project_slug = $1) AS sprints,
              (SELECT count(*) FROM development_items WHERE project_slug = $1) AS orders,
              (SELECT count(*) FROM bugs WHERE project_slug = $1) AS bugs`,
        [DEMO_SLUG],
      )
    ).rows[0],
  );
  log(
    `Beispielprojekt angelegt: ${counts.sprints} Sprints, ${counts.orders} Aufträge, ${counts.bugs} Bugs. Der laufende Sprint ist pausiert – Agents starten erst, wenn du ihn fortsetzt.`,
  );
  return 'created';
}
