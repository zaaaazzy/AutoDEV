// Bestätigungsliste der Vorschläge aus Doku-Abschnitten: Liste je Auftrag, Annehmen (Bug oder Idee), Verwerfen.
import type { Request, Response, Router } from 'express';
import type { Pool } from 'pg';
import { afterBugCreated } from '../agent/bug-classifier.js';
import { FOLLOW_UP_KIND, FOLLOW_UP_STATUS } from '../core/status.js';
import { isUuid } from '../core/validation.js';
import {
  decideProposal,
  insertProposalIdea,
  listOpenProposals,
  proposalExists,
  setProposalResult,
  type ProposalRow,
} from '../db/follow-up-proposal-repository.js';
import { withTransaction } from '../db/transaction.js';
import { access } from './access.js';
import { insertProposalBug } from './bugs.js';
import type { Principal } from './roles.js';

const ALREADY_DECIDED = 'Der Vorschlag wurde bereits angenommen oder verworfen.';

function decidedBy(response: Response): string {
  const principal = response.locals.principal as Principal | undefined;
  return (principal?.displayName || principal?.username || 'Nutzer').slice(0, 80);
}

/** 404 für unbekannte, 409 für schon entschiedene Vorschläge. */
async function sendNotOpen(pool: Pool, response: Response, id: string): Promise<void> {
  if (await proposalExists(pool, id)) response.status(409).json({ message: ALREADY_DECIDED });
  else response.status(404).json({ message: 'Vorschlag nicht gefunden.' });
}

async function listProposals(pool: Pool, request: Request<{ id: string }>, response: Response): Promise<void> {
  if (!isUuid(request.params.id)) {
    response.status(404).json({ message: 'Nicht gefunden.' });
    return;
  }
  response.json({ proposals: await listOpenProposals(pool, request.params.id) });
}

/**
 * Annehmen: Status wechseln, Bug bzw. Idee anlegen und verknüpfen in einer Transaktion. Der Statuswechsel prüft
 * „proposed“ in derselben Anweisung, ein zweiter Klick legt deshalb nichts mehr an (409).
 */
async function acceptProposal(pool: Pool, request: Request<{ id: string }>, response: Response): Promise<void> {
  const id = request.params.id;
  if (!isUuid(id)) {
    response.status(404).json({ message: 'Nicht gefunden.' });
    return;
  }
  const outcome = await withTransaction(pool, async (client) => {
    const proposal = await decideProposal(client, id, FOLLOW_UP_STATUS.accepted, decidedBy(response));
    if (!proposal) return null;
    const text = { projectSlug: proposal.projectSlug, title: proposal.title, description: proposal.description };
    const created =
      proposal.kind === FOLLOW_UP_KIND.bug
        ? await insertProposalBug(client, text)
        : { id: await insertProposalIdea(client, text), category: null };
    await setProposalResult(client, id, created.id);
    return { proposal: { ...proposal, status: FOLLOW_UP_STATUS.accepted, resultId: created.id }, created };
  });
  if (!outcome) {
    await sendNotOpen(pool, response, id);
    return;
  }
  const { proposal, created } = outcome;
  if (proposal.kind === FOLLOW_UP_KIND.bug) {
    afterBugCreated(pool, created.id, created.category, { title: proposal.title, description: proposal.description });
  }
  response.json({ proposal: publicRow(proposal) });
}

async function dismissProposal(pool: Pool, request: Request<{ id: string }>, response: Response): Promise<void> {
  const id = request.params.id;
  if (!isUuid(id)) {
    response.status(404).json({ message: 'Nicht gefunden.' });
    return;
  }
  const proposal = await decideProposal(pool, id, FOLLOW_UP_STATUS.dismissed, decidedBy(response));
  if (!proposal) {
    await sendNotOpen(pool, response, id);
    return;
  }
  response.json({ proposal: publicRow(proposal) });
}

/** Ohne project_slug, wie in der Liste. */
function publicRow(row: ProposalRow): ProposalRow {
  return {
    id: row.id,
    developmentId: row.developmentId,
    docId: row.docId,
    kind: row.kind,
    section: row.section,
    title: row.title,
    description: row.description,
    status: row.status,
    resultId: row.resultId,
    createdAt: row.createdAt,
  };
}

export function registerFollowUpProposalRoutes(app: Router, pool: Pool): void {
  app.get('/development/:id/follow-up-proposals', access({ tenant: 'development' }), (request, response) =>
    listProposals(pool, request, response),
  );
  app.post('/follow-up-proposals/:id/accept', access({ role: 'plan', tenant: 'follow-up-proposals' }), (req, res) =>
    acceptProposal(pool, req, res),
  );
  app.post('/follow-up-proposals/:id/dismiss', access({ role: 'plan', tenant: 'follow-up-proposals' }), (req, res) =>
    dismissProposal(pool, req, res),
  );
}
