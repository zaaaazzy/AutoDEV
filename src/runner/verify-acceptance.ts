import { logged } from '../core/log.js';
import type { Pool } from 'pg';
import { runAuthorAgent } from '../agent/requirements.js';
import type { CommandExecutor } from '../core/command.js';
import { isShuttingDown } from '../core/shutdown.js';
import { refreshAcceptanceTodo } from './action-todo.js';
import { parseChecks } from './acceptance.js';
import type { RunnerOptions } from './runner.js';

/**
 * Automatische Prüfung offener Abnahmepunkte: Der Tester-Agent prüft die angefragten Punkte im Projekt
 * (lesen, Tests und Befehle ausführen, nichts ändern) und meldet je Punkt erfüllt, nicht erfüllt oder „nur manuell“.
 */
interface Point {
  kind: string;
  position: number;
  text: string;
  note: string;
}

// Format der @@CHECK-Zeilen: gemeinsam mit der visuellen Prüfung in acceptance.ts.
export { parseChecks, type CheckResult } from './acceptance.js';

export function buildVerifyPrompt(item: { title: string; description: string }, points: Point[]): string {
  return [
    'Du bist der Tester im AIdeation. Prüfe die folgenden offenen Abnahmepunkte eines erledigten Auftrags selbst im Projekt: Code und Konfiguration lesen, Tests und Befehle ausführen, lokale Seiten und APIs mit WebFetch (nur localhost) abrufen. Ändere keine Dateien.',
    `## Auftrag\n${item.title}\n${item.description.slice(0, 3000)}`,
    `## Zu prüfende Punkte\n${points
      .map((point, index) => `${index + 1}. ${point.text}${point.note ? `\n   Bisher: ${point.note}` : ''}`)
      .join('\n')}`,
    'Antworte knapp. Schliesse mit genau einer Zeile je Punkt ab:\n@@CHECK {"nr":1,"met":true,"manual":false,"note":"kurze Begründung"}\nSetze "manual":true nur, wenn ein Mensch es prüfen muss (echtes Gerät, externe Konsole, anderer Rechner) – und beschreibe in "note" in wenigen Worten, was zu tun ist.',
  ].join('\n\n');
}

/** Übernimmt die nächste angefragte Prüfung eines Auftrags; liefert die Zahl geprüfter Punkte. */
export async function verifyAcceptance(
  pool: Pool,
  options: Pick<RunnerOptions, 'project' | 'cwd' | 'timeoutMs'>,
  execute?: CommandExecutor,
): Promise<number> {
  const claimed = (
    await pool.query<Point & { developmentId: string }>(
      `UPDATE acceptance_checks SET status = 'checking'
        WHERE status = 'verifying' AND development_id = (
          SELECT a.development_id FROM acceptance_checks a JOIN development_items d ON d.id = a.development_id
           WHERE d.project_slug = $1 AND a.status = 'verifying' LIMIT 1 FOR UPDATE OF a SKIP LOCKED)
        RETURNING development_id AS "developmentId", kind, position, text, note`,
      [options.project],
    )
  ).rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.position - b.position);
  const developmentId = claimed[0]?.developmentId;
  if (!developmentId) return 0;
  const item = (
    await pool.query<{ title: string; description: string }>(
      'SELECT title, description FROM development_items WHERE id = $1',
      [developmentId],
    )
  ).rows[0] ?? { title: '', description: '' };
  const tester = (
    await pool.query<{ id: string }>(
      `SELECT id FROM agents WHERE project_slug = $1 AND role = 'tester' AND enabled ORDER BY position LIMIT 1`,
      [options.project],
    )
  ).rows[0];
  const { exitCode, output } = await runAuthorAgent(
    pool,
    options,
    () => buildVerifyPrompt(item, claimed),
    execute,
    'assistant',
    undefined,
    undefined,
    tester?.id ?? null,
  );
  if (isShuttingDown()) {
    await pool.query(
      `UPDATE acceptance_checks SET status = 'verifying' WHERE development_id = $1 AND status = 'checking'`,
      [developmentId],
    );
    return 0;
  }
  const results = exitCode === 0 ? parseChecks(output) : [];
  for (const [index, point] of claimed.entries()) {
    const result = results.find((entry) => entry.nr === index + 1);
    const status = !result ? 'manual' : result.met ? 'met' : result.manual ? 'manual' : 'unmet';
    const note = result
      ? `${result.note} (vom Agent geprüft)`.trim()
      : `${point.note} (Agent konnte es nicht prüfen)`.trim();
    await pool.query(
      `UPDATE acceptance_checks SET status = $4, note = $5, checked_at = NOW()
        WHERE development_id = $1 AND kind = $2 AND position = $3 AND status = 'checking'`,
      [developmentId, point.kind, point.position, status, note.slice(0, 1000)],
    );
  }
  await refreshAcceptanceTodo(pool, developmentId).catch(logged('verify-acceptance'));
  return claimed.length;
}
