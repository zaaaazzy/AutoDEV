import { agentComposeProject } from './project-command.js';
import { HANDOFF_RULE } from '../core/workflow-phases.js';
import { acceptanceInstructions } from './acceptance.js';
import { reviewInstructions } from './review.js';
import { COVERAGE_INSTRUCTIONS } from './coverage.js';
import { containsUntrusted, UNTRUSTED_HINT } from './hoster.js';
import { isUntrustedBugSource } from '../core/bug-trust.js';
import type { PromptExtras, StepSummary, WorkItem, WorkflowAgent } from './runner-types.js';

export const PHASE_ORDER = ['pre_task', 'while_task', 'after_task'] as const;
const PROMPT_PLACEHOLDER = '{prompt}';
const PREVIOUS_OUTPUT_CHARS = 1_500;
const MANUAL_TITLE = 'Anwendungshandbuch';
const USER_MANUAL_TITLE = 'Benutzerhandbuch';
const MANUAL_PROMPT_CHARS = 12_000;
/** Der Entwickler listet am Ende jede geänderte Datei auf (der Tester-Schritt testet nur diese Dateien). */
export const CHANGED_FILES_INSTRUCTIONS = `## Geänderte Dateien melden
Beende deine Antwort mit dem Abschnitt „## Geänderte Dateien“ und liste darin jede Datei, die du angelegt, geändert oder gelöscht hast – eine Zeile pro Datei im Format \`- pfad/zur/datei\` (relativ zum Projektordner, gelöschte mit „(gelöscht)“). Lass keine Datei weg: Der Tester-Schritt testet nur die geänderten Dateien.`;

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
    agent.stepInstructions?.trim()
      ? `## Anweisung für diesen Schritt (hat Vorrang)\n${agent.stepInstructions.trim()}`
      : '',
    `## Entwicklungsauftrag ${item.id}${item.kind === 'bug' ? ' (Bugfix)' : ''}\nTitel: ${item.title}\n${item.description}`,
    containsUntrusted(item.description) || isUntrustedBugSource(item.bugSource) ? UNTRUSTED_HINT : '',
    item.risks?.trim() ? `## Risiken (vom Bug-Wächter geprüft)\n${item.risks.trim()}` : '',
    extras.images?.length
      ? `## Angehängte Bilder (aus Idee bzw. Bug-Meldung, relativ zum Projektordner)\n${extras.images.map((path) => `- ${path}`).join('\n')}`
      : '',
    bugs.length ? `## Bekannte Bugs – offene und behobene. Wiederhole diese Fehler nicht.\n${bugs.join('\n')}` : '',
    extras.manual !== undefined
      ? `## Bisheriges Handbuch (${agent.role === 'user_manual_writer' ? USER_MANUAL_TITLE : MANUAL_TITLE})\n${extras.manual.slice(0, MANUAL_PROMPT_CHARS) || '(noch leer – erstelle es vollständig)'}`
      : '',
    extras.sprintNotes?.trim() ? `## Vor dem Sprint (Planung)\n${extras.sprintNotes.trim().slice(0, 4000)}` : '',
    history.length ? `## Ergebnisse vorheriger Agents\n${history.join('\n\n')}` : '',
    extras.messages?.length
      ? `## Nachrichten an dich\n${extras.messages.map((message) => `- Von ${message.from}: ${message.text}`).join('\n')}`
      : '',
    extras.outcome ? `## Ergebnis des Auftrags\n${extras.outcome}` : '',
    agent.role === 'tester' ? COVERAGE_INSTRUCTIONS : '',
    agent.role === 'tester' && extras.definitionOfDone
      ? acceptanceInstructions(extras.criteria ?? [], extras.definitionOfDone)
      : '',
    agent.role === 'reviewer' ? reviewInstructions(extras.baseBranch ?? null) : '',
    agent.role === 'developer' ? CHANGED_FILES_INSTRUCTIONS : '',
    HANDOFF_RULE,
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

export function agentEnvironment(cwd?: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DEV_LOG_')));
  const compose = cwd ? agentComposeProject(cwd) : null;
  return compose ? { ...env, COMPOSE_PROJECT_NAME: compose } : env;
}

export { agentComposeProject };
