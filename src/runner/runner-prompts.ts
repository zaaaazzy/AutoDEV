import { COVERAGE_INSTRUCTIONS } from './coverage.js';
import type { PromptExtras, StepSummary, WorkItem, WorkflowAgent } from './runner-types.js';

export const PHASE_ORDER = ['pre_task', 'while_task', 'after_task'] as const;
const PROMPT_PLACEHOLDER = '{prompt}';
const PREVIOUS_OUTPUT_CHARS = 1_500;
const MANUAL_TITLE = 'Anwendungshandbuch';
const USER_MANUAL_TITLE = 'Benutzerhandbuch';
const MANUAL_PROMPT_CHARS = 12_000;

export function buildPrompt(
  agent: WorkflowAgent,
  item: WorkItem,
  previous: StepSummary[],
  extras: PromptExtras = {},
): string {
  const history = previous.map(
    (step) =>
      `### ${step.agentName} (${step.phase}, ${step.status})\n${step.output.trim().slice(-PREVIOUS_OUTPUT_CHARS)}`,
  );
  const bugs = (extras.bugs ?? []).map(
    (bug) =>
      `- [${bug.status === 'fixed' ? 'behoben' : 'offen'} / ${bug.severity}] ${bug.title}` +
      `${bug.description ? ` – ${bug.description.slice(0, 200)}` : ''}` +
      `${bug.fixNotes ? ` | Lösung: ${bug.fixNotes.slice(0, 300)}` : ''}`,
  );
  return [
    `Du bist der Agent "${agent.name}" (Rolle: ${agent.role}) in der Phase ${agent.phase}.`,
    `## Anweisung\n${agent.instructions || 'Keine zusätzliche Anweisung.'}`,
    `## Entwicklungsauftrag ${item.id}${item.kind === 'bug' ? ' (Bugfix)' : ''}\nTitel: ${item.title}\n${item.description}`,
    item.risks?.trim() ? `## Risiken (vom Bug-Wächter geprüft)\n${item.risks.trim()}` : '',
    extras.images?.length
      ? `## Angehängte Bilder (aus Idee bzw. Bug-Meldung, relativ zum Projektordner)\n${extras.images.map((path) => `- ${path}`).join('\n')}`
      : '',
    bugs.length ? `## Bekannte Bugs – offene und behobene. Wiederhole diese Fehler nicht.\n${bugs.join('\n')}` : '',
    extras.manual !== undefined
      ? `## Bisheriges Handbuch (${agent.role === 'user_manual_writer' ? USER_MANUAL_TITLE : MANUAL_TITLE})\n${extras.manual.slice(0, MANUAL_PROMPT_CHARS) || '(noch leer – erstelle es vollständig)'}`
      : '',
    history.length ? `## Ergebnisse vorheriger Agents\n${history.join('\n\n')}` : '',
    agent.role === 'tester' ? COVERAGE_INSTRUCTIONS : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Replaces the {prompt} placeholder, or appends the prompt as the last argument. */
export function buildInvocation(command: string[], prompt: string): string[] {
  return command.includes(PROMPT_PLACEHOLDER)
    ? command.map((part) => (part === PROMPT_PLACEHOLDER ? prompt : part))
    : [...command, prompt];
}

export function agentEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DEV_LOG_')));
}
