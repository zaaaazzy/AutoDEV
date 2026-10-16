import type { Agent, DevelopmentItem, RunStep } from '../core/models.js';
import type { ProjectStore } from '../core/project-store.js';

export interface WorkflowRow {
  key: string;
  name: string;
  step: RunStep | undefined;
}

type BoardData = ReturnType<ProjectStore['data']>;

/** Alle Agents eines Auftrags in Laufreihenfolge, jeweils mit dem neuesten Schritt (oder ohne Schritt = ausstehend). */
export function buildWorkflow(data: BoardData, item: DevelopmentItem): WorkflowRow[] {
  const steps = data.agentRuns
    .filter((run) => run.developmentId === item.id)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    .flatMap((run) => run.steps);
  const latest = (agent: Agent): RunStep | undefined => steps.filter((step) => step.agentId === agent.id).at(-1);
  const phases = ['pre_task', 'while_task', 'after_task'];
  const agents = data.agents
    .filter(
      (agent) =>
        agent.enabled &&
        !(agent.role === 'author' && item.ideationId) &&
        !(agent.role === 'bug_reviewer' && item.risks?.trim()),
    )
    .sort((left, right) => phases.indexOf(left.phase) - phases.indexOf(right.phase) || left.position - right.position);
  const known = new Set(agents.map((agent) => agent.id));
  const rows: WorkflowRow[] = agents.map((agent) => ({ key: agent.id, name: agent.name, step: latest(agent) }));
  for (const step of steps) {
    if (step.agentId && known.has(step.agentId)) continue;
    rows.push({ key: `${step.runId}-${step.position}`, name: step.agentName || 'Agent', step });
  }
  return rows;
}
