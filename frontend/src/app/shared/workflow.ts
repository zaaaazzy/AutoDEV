import type { Agent, DevelopmentItem, RunStep } from '../core/models.js';
import type { ProjectStore } from '../core/project-store.js';

export interface WorkflowRow {
  key: string;
  name: string;
  role?: string;
  command?: string[] | null;
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
  const phases = ['pre_task', 'while_task', 'after_task', 'on_rejected', 'on_done'];
  const agents = data.agents
    .filter(
      (agent) =>
        agent.enabled &&
        // „Vor dem Sprint“ gehört nicht zum Auftrag; „Bei abgelehnt/abgeschlossen“ nur, wenn sie gelaufen sind.
        agent.phase !== 'pre_sprint' &&
        (!['on_rejected', 'on_done'].includes(agent.phase) || latest(agent) !== undefined) &&
        !(agent.role === 'author' && item.ideationId) &&
        !(agent.role === 'bug_reviewer' && item.risks?.trim()),
    )
    .sort((left, right) => phases.indexOf(left.phase) - phases.indexOf(right.phase) || left.position - right.position);
  const known = new Set(agents.map((agent) => agent.id));
  const rows: WorkflowRow[] = agents.map((agent) => ({
    key: agent.id,
    name: agent.name,
    role: agent.role,
    command: agent.command,
    step: latest(agent),
  }));
  for (const step of steps) {
    if (step.agentId && known.has(step.agentId)) continue;
    rows.push({ key: `${step.runId}-${step.position}`, name: step.agentName || 'Agent', step });
  }
  return rows;
}

/** Wie ein Agent seinen letzten Schritt beendet hat – kurz für die Überschrift „Agents“. */
export interface AgentEnd {
  name: string;
  icon: string;
  label: string;
  tone: 'ok' | 'error' | 'warn' | 'running';
}

export function agentEnds(rows: WorkflowRow[]): AgentEnd[] {
  return rows.flatMap((row) => {
    const step = row.step;
    if (!step) return [];
    const output = step.output ?? '';
    const end = (icon: string, label: string, tone: AgentEnd['tone']): AgentEnd[] => [
      { name: row.name, icon, label, tone },
    ];
    if (step.status === 'running') return end('⏳', 'läuft', 'running');
    if (step.status === 'passed') return end('✓', 'bestanden', 'ok');
    if (/Vom Benutzer abgebrochen/.test(output)) return end('⏹', 'abgebrochen', 'warn');
    if (/Unterbrochen:/.test(output)) return end('⏸', 'unterbrochen', 'warn');
    if (step.status === 'failed') return end('✗', 'gescheitert', 'error');
    return end('•', step.status, 'warn');
  });
}
