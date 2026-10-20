import type { Pool } from 'pg';
import { loadProposal } from '../api/sprint-planning.js';
import type { PlannedItem } from '../core/sprint-planner.js';
import type { CommandExecutor } from '../core/command.js';
import type { RunnerOptions } from '../runner/runner.js';
import { runAuthorAgent } from './requirements.js';

/**
 * KI-Feinschliff der Sprintplanung: Der Auftragsautor kommentiert den Vorschlag in 3–5 Sätzen (Sprintziel,
 * Risiken). Nur Text – die Auswahl bleibt deterministisch, der Kommentar wird beim Übernehmen verworfen.
 */
export const MAX_SENTENCES = 5;

export function buildSprintCommentPrompt(
  instructions: string,
  sprint: { name: string; capacityHours: number; hours: number; tokens: number },
  items: Pick<PlannedItem, 'title' | 'score' | 'reason' | 'hours' | 'tokens'>[],
): string {
  return [
    'Du bist der Agent "Auftragsautor" und kommentierst einen Sprintvorschlag, den AIdeation berechnet hat.',
    `## Anweisung\n${instructions || 'Formuliere knapp und sachlich.'}`,
    `## ${sprint.name}\nKapazität ${sprint.capacityHours} h · geplant ${sprint.hours} h, ${sprint.tokens} Tokens`,
    `## Aufträge in dieser Reihenfolge\n${items
      .map(
        (item, index) =>
          `${index + 1}. ${item.title} (Score ${item.score}, ${item.hours} h${item.tokens ? `, ${item.tokens} Tokens` : ''}) – ${item.reason}`,
      )
      .join('\n')}`,
    'Schreibe 3 bis 5 Sätze als reinen Fließtext ohne Markdown, Listen oder Überschriften: ein Sprintziel in einem ' +
      'Satz, danach die wichtigsten Risiken (Abhängigkeiten, gleiche Dateien, Kapazität, blockierte Aufträge). ' +
      'Schlage keine anderen Aufträge vor und ändere nichts – weder Dateien noch die Auswahl.',
  ].join('\n\n');
}

/** Macht aus der Antwort reinen Text mit höchstens 5 Sätzen; null, wenn nichts Brauchbares übrig bleibt. */
export function plainComment(output: string): string | null {
  const text = output
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/gm, '')
    .replace(/\*\*|__|`|\*/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  // Satzende = Satzzeichen vor einem Leerzeichen (Dateinamen wie „src/a.ts“ bleiben ganz).
  return text
    .split(/(?<=[.!?]["“”»]?)\s+/)
    .slice(0, MAX_SENTENCES)
    .join(' ')
    .slice(0, 1500);
}

/** Arbeitet einen angefragten Kommentar des Projekts ab (Worker); true, wenn einer bearbeitet wurde. */
export async function commentSprintProposal(
  pool: Pool,
  options: Pick<RunnerOptions, 'project' | 'cwd' | 'timeoutMs'>,
  execute?: CommandExecutor,
): Promise<boolean> {
  // Abgebrochene Läufe (Neustart des Workers) erneut anfragen.
  await pool.query(
    `UPDATE sprint_proposal_comments SET status = 'requested'
      WHERE project_slug = $1 AND status = 'running' AND requested_at < NOW() - INTERVAL '15 minutes'`,
    [options.project],
  );
  const claimed = (
    await pool.query<{ itemIds: string[] }>(
      `UPDATE sprint_proposal_comments SET status = 'running', requested_at = NOW()
        WHERE project_slug = $1 AND status = 'requested' RETURNING item_ids AS "itemIds"`,
      [options.project],
    )
  ).rows[0];
  if (!claimed) return false;
  const finish = (status: 'done' | 'failed', comment: string) =>
    pool.query(
      `UPDATE sprint_proposal_comments SET status = $2, comment = $3, finished_at = NOW()
        WHERE project_slug = $1 AND status = 'running'`,
      [options.project, status, comment],
    );
  const proposal = await loadProposal(pool, options.project);
  const byId = new Map((proposal?.items ?? []).map((item) => [item.id, item]));
  const items = claimed.itemIds.map((id) => byId.get(id)).filter((item): item is PlannedItem => !!item);
  if (!proposal || !items.length) {
    await finish('failed', 'Der Vorschlag hat sich geändert – bitte neu anfragen.');
    return true;
  }
  const sprint = {
    name: proposal.name,
    capacityHours: proposal.capacity.hours,
    hours: Math.round(items.reduce((sum, item) => sum + item.hours, 0) * 10) / 10,
    tokens: items.reduce((sum, item) => sum + (item.tokens ?? 0), 0),
  };
  const { exitCode, output } = await runAuthorAgent(
    pool,
    options,
    (instructions) => buildSprintCommentPrompt(instructions, sprint, items),
    execute,
  );
  const comment = exitCode === 0 ? plainComment(output) : null;
  await finish(comment ? 'done' : 'failed', comment ?? 'Der Auftragsautor hat keinen Kommentar geliefert.');
  return true;
}
