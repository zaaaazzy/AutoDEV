/**
 * Der Agent-Aufruf eines Workflow-Schritts: Abbruch aus der Oberfläche, Live-Ausgabe, Fortschrittsmeldung und ein
 * zweiter Versuch nach einem vorübergehenden Fehler. Was danach mit dem Ergebnis geschieht, entscheidet runner-steps.
 */
import { logged } from '../core/log.js';
import { startProgress } from '../agent/chat-progress.js';
import { type CommandResult, redactOutput } from '../core/command.js';
import { isShuttingDown, killGroup } from '../core/shutdown.js';
import { AGENT_STEP_STATUS } from '../core/status.js';
import { isTransientFailure } from './autofix.js';
import type { BudgetState } from './budget.js';
import type { WorkflowAgent } from './runner-types.js';
import { type AgentResult, findResumableSession, invokeAgent, routeStep, type StepHooks } from './runner-agent.js';
import { guardedBudgetGate, logEvent, type RunContext } from './runner-context.js';
import { TRANSIENT_RETRY_DELAY_MS } from './runner-runs.js';

const CANCEL_POLL_MS = 1500;
const LIVE_OUTPUT_INTERVAL_MS = 1500;

export interface Invocation {
  result: AgentResult;
  /** Vom Benutzer abgebrochen („Abbrechen“, Sprint-Abbruch). */
  cancelled: boolean;
  /** Budget vor dem zweiten Versuch erreicht: kein neuer Versuch, der Lauf hält an. */
  budgetStop: BudgetState | null;
  /** Budget vor dem zweiten Versuch nicht prüfbar (Fehlertext): unterbrochen statt gescheitert. */
  budgetUnchecked?: string;
  /** Beginn des ersten Versuchs, um einen Ordner-Ausfall währenddessen zu erkennen. */
  startedAt: number;
}

/**
 * Nur ein Fehler des Agents selbst (Modell bzw. Dienst nicht erreichbar, überlastet, Zeitlimit) ist vorübergehend.
 * Rote Projekttests oder die visuelle Prüfung werden nie wiederholt, auch wenn ihre Ausgabe z. B. ECONNREFUSED enthält.
 */
export function shouldRetry(result: AgentResult): boolean {
  return result.exitCode !== 0 && !result.fromTests && isTransientFailure(result.output);
}

/** Abbruch aus der Oberfläche: beendet den Schritt sofort, auch wenn der Agent nicht reagiert. */
interface CancelWatch {
  requested: Promise<CommandResult>;
  cancelled: () => boolean;
  signal: AbortSignal;
  /** Prozessgruppe des Agents, die ein Abbruch beendet. */
  setPid: (pid: number) => void;
  stop: () => void;
}

function watchCancel(pool: RunContext['pool'], stepId: string): CancelWatch {
  const abort = new AbortController();
  let pid = 0;
  let cancelled = false;
  let stop = (): void => undefined;
  const requested = new Promise<CommandResult>((resolveCancel) => {
    const watcher = setInterval(() => {
      void pool
        .query<{ cancel_requested: boolean }>('SELECT cancel_requested FROM agent_run_steps WHERE id = $1', [stepId])
        .then(({ rows }) => {
          if (!rows[0]?.cancel_requested || cancelled) return;
          cancelled = true;
          abort.abort();
          if (pid) killGroup(pid);
          resolveCancel({ exitCode: 130, durationMs: 0, output: 'Vom Benutzer abgebrochen.' });
        })
        .catch(logged('step-invocation'));
    }, CANCEL_POLL_MS);
    stop = () => clearInterval(watcher);
  });
  return {
    requested,
    cancelled: () => cancelled,
    signal: abort.signal,
    setPid: (next) => {
      pid = next;
    },
    stop: () => stop(),
  };
}

/** Rückmeldungen des laufenden Agents: Live-Ausgabe (gedrosselt), Ereignisse, PID und Sitzung am Schritt speichern. */
async function stepHooks(
  ctx: RunContext,
  agent: WorkflowAgent,
  stepId: string,
  cancel: CancelWatch,
  live: { update?: (message: string) => void },
): Promise<StepHooks> {
  const { pool, item } = ctx;
  let lastLiveWrite = 0;
  const hooks: StepHooks = {
    signal: cancel.signal,
    onOutput: (partial) => {
      if (Date.now() - lastLiveWrite < LIVE_OUTPUT_INTERVAL_MS) return;
      lastLiveWrite = Date.now();
      void pool
        .query('UPDATE agent_run_steps SET output = $2 WHERE id = $1 AND status = $3', [
          stepId,
          redactOutput(partial, process.env),
          AGENT_STEP_STATUS.running,
        ])
        .catch(logged('step-invocation'));
    },
    onAction: (message) => {
      void logEvent(pool, stepId, message);
      live.update?.(message);
    },
    onSpawn: (pid) => {
      cancel.setPid(pid);
      void pool
        .query('UPDATE agent_run_steps SET pid = $2, pid_started_at = NOW() WHERE id = $1', [stepId, pid])
        .catch(logged('step-invocation'));
    },
    onSession: (sessionId) => {
      void pool
        .query('UPDATE agent_run_steps SET session_id = $2, session_at = NOW() WHERE id = $1', [stepId, sessionId])
        .catch(logged('step-invocation'));
    },
    resume: await findResumableSession(pool, item.id, agent, stepId).catch(logged('step-invocation', null)),
  };
  if (hooks.resume) {
    await logEvent(
      pool,
      stepId,
      hooks.resume.passed ? 'Setzt frühere Sitzung fort (Nachbesserung)' : 'Setzt abgebrochene Sitzung fort',
    );
  }
  return hooks;
}

/** Zwei Versuche zu einem Ergebnis zusammenfassen: Dauer, Tokens und Kosten addieren, beide Ausgaben behalten. */
function combineAttempts(first: AgentResult, second: AgentResult): AgentResult {
  return {
    ...second,
    durationMs: first.durationMs + second.durationMs,
    tokens: (first.tokens ?? 0) + (second.tokens ?? 0),
    costUsd: (first.costUsd ?? 0) + (second.costUsd ?? 0),
    output: `## Erster Versuch (vorübergehender Fehler)\n${first.output.slice(-1500)}\n\n## Zweiter Versuch\n${second.output}`,
  };
}

/**
 * Ein Versuch des Agents. Der Abbruch meldet sich sofort, Git-Schritte (Commit, checkout base) dürfen aber erst laufen,
 * wenn der Agent wirklich beendet ist – sonst schreiben restliche Werkzeuge weiter und landen auf dem Basis-Branch. Das
 * Signal erreicht Modell, Werkzeuge und Prozessgruppen, das Warten endet also. Tokens und Kosten des abgebrochenen
 * Laufs bleiben.
 */
async function attempt(
  ctx: RunContext,
  agent: WorkflowAgent,
  prompt: string,
  hooks: StepHooks,
  routed: Awaited<ReturnType<typeof routeStep>>,
  cancel: CancelWatch,
  stepId: string,
): Promise<AgentResult> {
  const running = invokeAgent(ctx, agent, prompt, hooks, routed).catch((error: unknown): AgentResult => ({
    exitCode: 1,
    durationMs: 0,
    output: error instanceof Error ? error.message : String(error),
  }));
  const first = await Promise.race([running, cancel.requested]);
  if (!cancel.cancelled()) return first;
  await logEvent(ctx.pool, stepId, 'Abbruch – warte, bis der Agent beendet ist');
  const ended = await running;
  return { ...first, durationMs: ended.durationMs, tokens: ended.tokens, costUsd: ended.costUsd };
}

/**
 * Vorübergehender Fehler des Agents (Modell kurz weg, überlastet, Zeitlimit): einmal nach kurzer Pause wiederholen –
 * aber nur, wenn das Budget den zweiten Versuch noch erlaubt. Ist es nicht prüfbar, gibt es keinen zweiten Versuch.
 */
async function retryAfterTransientFailure(
  ctx: RunContext,
  agent: WorkflowAgent,
  stepId: string,
  first: AgentResult,
  cancel: CancelWatch,
  live: { update?: (message: string) => void },
  secondAttempt: () => Promise<AgentResult>,
): Promise<Pick<Invocation, 'result' | 'budgetStop' | 'budgetUnchecked'>> {
  const { pool, options } = ctx;
  const budget = await guardedBudgetGate(ctx, agent);
  if (budget.failed) {
    await logEvent(pool, stepId, 'Vorübergehender Fehler – kein neuer Versuch, das Budget ist nicht prüfbar');
    return { result: first, budgetStop: budget.stop, budgetUnchecked: budget.failed };
  }
  if (budget.stop) {
    await logEvent(pool, stepId, 'Vorübergehender Fehler – kein neuer Versuch, das Budget ist erreicht');
    return { result: first, budgetStop: budget.stop };
  }
  const delay = options.transientRetryDelayMs ?? TRANSIENT_RETRY_DELAY_MS;
  await logEvent(pool, stepId, `Vorübergehender Fehler – neuer Versuch in ${Math.round(delay / 1000)} s`);
  live.update?.(`${agent.name}: vorübergehender Fehler, neuer Versuch …`);
  const paused = await Promise.race([
    new Promise<null>((resolveDelay) => setTimeout(() => resolveDelay(null), delay)),
    cancel.requested,
  ]);
  if (paused === null && !cancel.cancelled() && !isShuttingDown()) {
    return { result: combineAttempts(first, await secondAttempt()), budgetStop: null };
  }
  return { result: paused ?? first, budgetStop: null };
}

/** Führt den Agent aus (mit Abbruch-Überwachung, Fortschritt und einem Versuch der Wiederholung) und liefert das Rohergebnis. */
export async function invokeWithRetry(
  ctx: RunContext,
  agent: WorkflowAgent,
  prompt: string,
  routed: Awaited<ReturnType<typeof routeStep>>,
  stepId: string,
  position: number,
  total: number,
): Promise<Invocation> {
  const { pool, item } = ctx;
  const cancel = watchCancel(pool, stepId);
  const live: { update?: (message: string) => void } = {};
  const hooks = await stepHooks(ctx, agent, stepId, cancel, live);
  const progress = await startProgress(
    pool,
    item.projectSlug,
    [
      `${agent.name} beginnt (Schritt ${position + 1}/${total}) …`,
      `${agent.name} arbeitet an „${item.title}“ …`,
      `${agent.name} ist noch dabei …`,
    ],
    { stepId, silent: true },
  );
  live.update = progress.update;
  const startedAt = Date.now();
  const run = (): Promise<AgentResult> => attempt(ctx, agent, prompt, hooks, routed, cancel, stepId);
  try {
    const first = await run();
    if (cancel.cancelled() || isShuttingDown() || !shouldRetry(first)) {
      return { result: first, cancelled: cancel.cancelled(), budgetStop: null, startedAt };
    }
    const retried = await retryAfterTransientFailure(ctx, agent, stepId, first, cancel, live, run);
    return { ...retried, cancelled: cancel.cancelled(), startedAt };
  } finally {
    cancel.stop();
    await progress.stop();
  }
}
