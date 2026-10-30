/**
 * Phasen des Agent-Workflows (Spalten im Workflow-Board unter „Agents“).
 * - pre_sprint: einmal beim Start eines Sprints, nur lesend (Planung, Prüfung)
 * - pre_task / while_task / after_task: für jeden Auftrag, in dieser Reihenfolge
 * - on_rejected / on_done: am Ende eines Auftrags, wenn er gescheitert bzw. erfolgreich ist (ändern den Status nicht)
 */
export const WORKFLOW_PHASES = [
  'pre_sprint',
  'pre_task',
  'while_task',
  'after_task',
  'on_rejected',
  'on_done',
] as const;

/** Phasen, die als Schritte eines Auftrags nacheinander laufen. */
export const ORDER_PHASES = ['pre_task', 'while_task', 'after_task'] as const;

export const PHASE_SET = new Set<string>(WORKFLOW_PHASES);

/** SQL-Sortierung nach Workflow-Reihenfolge (für ORDER BY). */
export const PHASE_SQL_ORDER = `CASE phase ${WORKFLOW_PHASES.map((phase, index) => `WHEN '${phase}' THEN ${index}`).join(' ')} ELSE ${WORKFLOW_PHASES.length} END`;

/** Agents geben dem nächsten (oder einem bestimmten) Agent eine Nachricht mit. */
export const HANDOFF_RULE =
  'Nachricht an den nächsten Agent: Willst du dem nächsten Agent im Workflow etwas mitgeben (Hinweis, offene Frage, Entscheidung), schreibe eine eigene Zeile `@@NACHRICHT: <Text>`. An einen bestimmten Agent: `@@NACHRICHT an <Name>: <Text>`.';

const HANDOFF = /^@@NACHRICHT(?:\s+an\s+([^:\n]+?))?\s*:\s*(.+)$/gim;

export interface Handoff {
  /** Name des Empfängers aus der Zeile (null = nächster bzw. konfigurierter Agent). */
  to: string | null;
  text: string;
}

export function parseHandoffs(output: string): Handoff[] {
  return [...output.matchAll(HANDOFF)]
    .map((match) => ({ to: match[1]?.trim() || null, text: (match[2] ?? '').trim().slice(0, 2000) }))
    .filter((handoff) => handoff.text);
}

export interface HandoffAgent {
  id: string;
  name: string;
  handoffTo?: string | null;
  stepId?: string | null;
}

/**
 * Empfänger einer Nachricht: ausdrücklich genannter Agent, sonst der beim Absender eingestellte, sonst der nächste in
 * der Reihenfolge. null, wenn es keinen Empfänger mehr gibt.
 */
export function handoffTarget<T extends HandoffAgent>(
  handoff: Handoff,
  from: HandoffAgent,
  ordered: readonly T[],
  /** Stelle des Absenders im Ablauf (derselbe Agent kann mehrfach vorkommen); sonst die erste mit seiner ID. */
  fromIndex = ordered.findIndex((agent) => agent.id === from.id),
): T | null {
  // Bei mehreren Einsätzen desselben Agents gilt der nächste nach dem Absender, sonst der erste.
  const later = (match: (agent: T) => boolean): T | undefined =>
    ordered.slice(fromIndex + 1).find(match) ?? ordered.find(match);
  const name = handoff.to?.toLowerCase();
  const named = name ? later((agent) => agent.name.toLowerCase() === name) : undefined;
  if (named) return named;
  const configured = from.handoffTo ? later((agent) => agent.id === from.handoffTo) : undefined;
  if (configured) return configured;
  return fromIndex >= 0 ? (ordered[fromIndex + 1] ?? null) : null;
}
