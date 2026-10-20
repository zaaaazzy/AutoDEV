import type { Pool } from 'pg';
import { runAuthorAgent } from '../agent/requirements.js';
import type { CommandExecutor } from '../core/command.js';
import { logged } from '../core/log.js';
import { handoffTarget, HANDOFF_RULE, parseHandoffs } from '../core/workflow-phases.js';
import { projectBudgetExceeded } from './budget.js';
import type { RunnerOptions } from './runner.js';
import type { WorkflowAgent } from './runner-types.js';

/** Rolle, unter der „Vor dem Sprint“ läuft: nur lesen (siehe READ_ONLY_ROLES). */
export const PRE_SPRINT_ROLE = 'pre_sprint';

/** So oft wird eine gescheiterte Phase „Vor dem Sprint“ wiederholt, bevor die Aufträge ohne sie starten. */
export const PRE_SPRINT_ATTEMPTS = 3;
/** Gescheiterte Versuche je Sprint (seit dem Start des Workers). */
const failedAttempts = new Map<string, number>();

interface ActiveSprint {
  id: string;
  name: string;
  goal: string | null;
}

/** Anweisung für einen Agent „Vor dem Sprint“: Sprint, Aufträge und Nachrichten der Agents davor. */
export function preSprintPrompt(
  agent: WorkflowAgent,
  instructions: string,
  sprint: ActiveSprint,
  orders: { title: string; status: string }[],
  messages: { from: string; text: string }[],
  previous: { agent: string; output: string }[],
): string {
  return [
    `Du bist der Agent "${agent.name}" (Rolle: ${agent.role}) in der Phase „Vor dem Sprint“. Du arbeitest nur lesend: ` +
      'prüfe und plane, ändere keine Dateien. Dein Ergebnis bekommen alle Agents der Aufträge dieses Sprints mit.',
    `## Anweisung\n${instructions || agent.instructions || 'Prüfe den Sprint und gib Hinweise für die Umsetzung.'}`,
    agent.stepInstructions?.trim()
      ? `## Anweisung für diesen Schritt (hat Vorrang)\n${agent.stepInstructions.trim()}`
      : '',
    `## Sprint ${sprint.name}${sprint.goal ? `\nZiel: ${sprint.goal}` : ''}\n${
      orders.map((order) => `- [${order.status}] ${order.title}`).join('\n') || '(noch keine Aufträge)'
    }`,
    previous.length
      ? `## Ergebnisse vorheriger Agents\n${previous.map((step) => `### ${step.agent}\n${step.output.slice(-3000)}`).join('\n\n')}`
      : '',
    messages.length ? `## Nachrichten an dich\n${messages.map((m) => `- Von ${m.from}: ${m.text}`).join('\n')}` : '',
    HANDOFF_RULE,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Einmal je Sprint, bevor dessen erster Auftrag startet: die Agents der Phase „Vor dem Sprint“ nacheinander. Ihr
 * Ergebnis steht danach in sprints.pre_sprint_notes und fliesst in jede Agent-Anweisung der Aufträge.
 * Liefert true, wenn in diesem Zyklus gearbeitet wurde (dann starten die Aufträge erst im nächsten Zyklus).
 */
export async function runPreSprint(
  pool: Pool,
  options: Pick<RunnerOptions, 'project' | 'cwd' | 'timeoutMs'>,
  agents: WorkflowAgent[],
  execute?: CommandExecutor,
): Promise<boolean> {
  const sprint = (
    await pool.query<ActiveSprint>(
      `SELECT id, name, goal FROM sprints WHERE project_slug = $1 AND status = 'active' AND pre_sprint_at IS NULL AND paused_at IS NULL
        ORDER BY created_at LIMIT 1`,
      [options.project],
    )
  ).rows[0];
  if (!sprint) return false;
  const ordered = agents.filter((agent) => agent.phase === 'pre_sprint');
  if (!ordered.length) {
    await pool.query(`UPDATE sprints SET pre_sprint_at = NOW() WHERE id = $1`, [sprint.id]);
    return false;
  }
  // Budget erreicht: die Phase nicht verbrauchen, sondern nachholen, sobald das Budget wieder reicht. Die Aufträge
  // warten ohnehin (holdForBudget in runWorkflow).
  if (await projectBudgetExceeded(pool, options.project).catch(logged('pre-sprint', null))) return false;
  const orders = (
    await pool.query<{ title: string; status: string }>(
      `SELECT title, status FROM development_items WHERE sprint_id = $1 ORDER BY sprint_rank NULLS LAST, created_at`,
      [sprint.id],
    )
  ).rows;
  const messages: { toId: string; from: string; text: string }[] = [];
  const results: { agent: string; output: string }[] = [];
  for (const [index, agent] of ordered.entries()) {
    console.info(`[${options.project}] Vor dem Sprint › ${agent.name}`);
    const { exitCode, output } = await runAuthorAgent(
      pool,
      options,
      (instructions) =>
        preSprintPrompt(
          agent,
          instructions,
          sprint,
          orders,
          messages.filter((message) => message.toId === (agent.stepId ?? agent.id)),
          results,
        ),
      execute,
      PRE_SPRINT_ROLE,
      undefined,
      undefined,
      agent.id,
    );
    if (exitCode !== 0) {
      // Budget unterwegs erreicht: kein Fehlversuch, die Phase wird nachgeholt, sobald das Budget wieder reicht.
      if (await projectBudgetExceeded(pool, options.project).catch(logged('pre-sprint', null))) return false;
      // Sonst gescheitert (Modell nicht erreichbar …): Die Phase gilt nicht als erledigt und läuft im nächsten Zyklus
      // erneut. Erst nach PRE_SPRINT_ATTEMPTS Versuchen starten die Aufträge ohne sie – die Fehlermeldung landet nie
      // als Sprint-Hinweis in den Agent-Anweisungen.
      const attempts = (failedAttempts.get(sprint.id) ?? 0) + 1;
      failedAttempts.set(sprint.id, attempts);
      console.error(
        `[${options.project}] Vor dem Sprint › ${agent.name} gescheitert (Versuch ${attempts}/${PRE_SPRINT_ATTEMPTS}): ${output.trim().slice(-300)}`,
      );
      if (attempts < PRE_SPRINT_ATTEMPTS) return true;
      break;
    }
    results.push({ agent: agent.name, output: output.trim() });
    for (const handoff of parseHandoffs(output)) {
      const target = handoffTarget(handoff, agent, ordered, index);
      if (target) messages.push({ toId: target.stepId ?? target.id, from: agent.name, text: handoff.text });
    }
  }
  failedAttempts.delete(sprint.id);
  const notes =
    results
      .map((result) => `### ${result.agent}\n${result.output}`)
      .join('\n\n')
      .slice(0, 20_000) || null;
  await pool.query(`UPDATE sprints SET pre_sprint_at = NOW(), pre_sprint_notes = $2 WHERE id = $1`, [sprint.id, notes]);
  return true;
}
