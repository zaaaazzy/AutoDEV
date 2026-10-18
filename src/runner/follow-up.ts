import type { Pool } from 'pg';
import { orderBranch } from './git-sync.js';

const MAX_DOC_CHARS = 4000;

/**
 * Kontext für Folgeaufträge: worauf sich der Auftrag bezieht (Titel, Beschreibung, Dokumentation, Git-Branch),
 * damit der Entwickler beim abgeschlossenen Auftrag weitermacht statt von vorne zu beginnen.
 */
export async function loadFollowUpContext(pool: Pool, itemId: string): Promise<string> {
  const previous = (
    await pool.query<{ id: string; title: string; description: string; completedAt: Date | null; doc: string | null }>(
      `SELECT p.id, p.title, p.description, p.completed_at AS "completedAt",
              (SELECT d.content FROM docs d WHERE d.development_id = p.id AND d.kind = 'order'
                ORDER BY d.updated_at DESC LIMIT 1) AS doc
         FROM development_items i JOIN development_items p ON p.id = i.follow_up_of
        WHERE i.id = $1`,
      [itemId],
    )
  ).rows[0];
  if (!previous) return '';
  return buildFollowUpContext(previous);
}

export function buildFollowUpContext(previous: {
  id: string;
  title: string;
  description: string;
  completedAt: Date | null;
  doc: string | null;
}): string {
  const branch = orderBranch(previous);
  const doc = previous.doc?.trim() ?? '';
  return [
    `## Bezug: Folgeauftrag zu „${previous.title}“`,
    `Dieser Auftrag baut auf dem abgeschlossenen Auftrag „${previous.title}“${
      previous.completedAt ? ` (erledigt am ${previous.completedAt.toISOString().slice(0, 10)})` : ''
    } auf. Der Kontext bezieht sich auf diesen letzten Auftrag: Arbeite auf dessen Ergebnis weiter, ändere oder ergänze es gezielt und beginne nicht von vorne.`,
    `Die damaligen Änderungen findest du im Git-Verlauf: Branch \`${branch}\` bzw. \`git log --all --grep "${previous.id.slice(0, 8)}"\` oder \`git log --all --oneline -- <Datei>\`.`,
    previous.description.trim() ? `### Damaliger Auftrag\n${previous.description.trim().slice(0, 3000)}` : '',
    doc
      ? `### Dokumentation des damaligen Auftrags\n${doc.length > MAX_DOC_CHARS ? `${doc.slice(0, MAX_DOC_CHARS)}\n…` : doc}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
