// Datenzugriff für Vorschläge aus Doku-Abschnitten (follow_up_proposals): Speichern, Liste, Annehmen, Verwerfen.
import { BUG_STATUS, CLOSED_IDEATION_STATUSES, FOLLOW_UP_STATUS, type FollowUpKind } from '../core/status.js';
import type { Queryable } from './transaction.js';

export const PROPOSAL_COLUMNS = `id, development_id AS "developmentId", doc_id AS "docId", kind, section, title,
  description, status, result_id AS "resultId", created_at AS "createdAt"`;

export interface ProposalRow {
  id: string;
  developmentId: string;
  docId: string | null;
  kind: FollowUpKind;
  section: string;
  title: string;
  description: string;
  status: string;
  resultId: string | null;
  createdAt: string;
}

export interface NewProposal {
  kind: FollowUpKind;
  section: string;
  title: string;
  description: string;
}

/** Doku-Eintrag des Auftrags (kind = 'order'); saveOrderDoc liefert keine ID. */
export async function loadOrderDoc(
  db: Queryable,
  developmentId: string,
): Promise<{ id: string; projectSlug: string; content: string } | null> {
  const result = await db.query<{ id: string; projectSlug: string; content: string }>(
    `SELECT id, project_slug AS "projectSlug", content FROM docs WHERE kind = 'order' AND development_id = $1`,
    [developmentId],
  );
  return result.rows[0] ?? null;
}

/** Titel offener Bugs und Ideen des Projekts: nur sie gelten bei Vorschlägen als Dubletten. */
export async function loadOpenTitles(db: Queryable, projectSlug: string): Promise<{ id: string; title: string }[]> {
  const closedIdeas = CLOSED_IDEATION_STATUSES.map((status) => `'${status}'`).join(', ');
  const result = await db.query<{ id: string; title: string }>(
    `SELECT id, title FROM bugs WHERE project_slug = $1 AND status IN ('${BUG_STATUS.open}', '${BUG_STATUS.inProgress}')
     UNION ALL
     SELECT id, title FROM ideation_items WHERE project_slug = $1 AND status NOT IN (${closedIdeas})`,
    [projectSlug],
  );
  return result.rows;
}

/** Speichert Vorschläge mit Status proposed; ein schon vorhandener Titel zum Auftrag bleibt unverändert. */
export async function insertProposals(
  db: Queryable,
  target: { projectSlug: string; developmentId: string; docId: string },
  proposals: readonly NewProposal[],
): Promise<number> {
  let saved = 0;
  for (const proposal of proposals) {
    const result = await db.query(
      `INSERT INTO follow_up_proposals (project_slug, development_id, doc_id, kind, section, title, description, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '${FOLLOW_UP_STATUS.proposed}')
       ON CONFLICT (development_id, title) DO NOTHING`,
      [
        target.projectSlug,
        target.developmentId,
        target.docId,
        proposal.kind,
        proposal.section,
        proposal.title,
        proposal.description,
      ],
    );
    saved += result.rowCount ?? 0;
  }
  return saved;
}

/** Offene Vorschläge eines Auftrags (Bestätigungsliste). */
export async function listOpenProposals(db: Queryable, developmentId: string): Promise<ProposalRow[]> {
  const result = await db.query<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS} FROM follow_up_proposals
      WHERE development_id = $1 AND status = '${FOLLOW_UP_STATUS.proposed}' ORDER BY created_at, title`,
    [developmentId],
  );
  return result.rows;
}

/**
 * Setzt einen offenen Vorschlag auf den neuen Status. Prüfung und Änderung in einer Anweisung: Bei zwei
 * gleichzeitigen Klicks gewinnt einer, der andere bekommt null.
 */
export async function decideProposal(
  db: Queryable,
  id: string,
  status: typeof FOLLOW_UP_STATUS.accepted | typeof FOLLOW_UP_STATUS.dismissed,
  decidedBy: string,
): Promise<(ProposalRow & { projectSlug: string }) | null> {
  const result = await db.query<ProposalRow & { projectSlug: string }>(
    `UPDATE follow_up_proposals SET status = $2, decided_by = $3, decided_at = NOW()
      WHERE id = $1 AND status = '${FOLLOW_UP_STATUS.proposed}'
      RETURNING ${PROPOSAL_COLUMNS}, project_slug AS "projectSlug"`,
    [id, status, decidedBy],
  );
  return result.rows[0] ?? null;
}

export async function setProposalResult(db: Queryable, id: string, resultId: string): Promise<void> {
  await db.query('UPDATE follow_up_proposals SET result_id = $2 WHERE id = $1', [id, resultId]);
}

export async function proposalExists(db: Queryable, id: string): Promise<boolean> {
  return Boolean((await db.query('SELECT 1 FROM follow_up_proposals WHERE id = $1', [id])).rowCount);
}

/** Idee aus einem angenommenen Vorschlag; ein Mensch hat sie bestätigt, daher Quelle „human“. */
export async function insertProposalIdea(
  db: Queryable,
  idea: { projectSlug: string; title: string; description: string },
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO ideation_items (project_slug, title, description, source) VALUES ($1, $2, $3, 'human') RETURNING id`,
    [idea.projectSlug, idea.title, idea.description],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Idee aus dem Vorschlag wurde nicht angelegt.');
  return row.id;
}
