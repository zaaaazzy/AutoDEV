import { logged } from '../core/log.js';
import { isDraining, isShuttingDown } from '../core/shutdown.js';
import { runPreSprint } from './pre-sprint.js';
import { processApprovals } from './review-gate.js';
import { folderAvailable, hadOutage } from '../core/folder-guard.js';
import type { Pool } from 'pg';
import { AGENT_RUN_STATUS, AGENT_STEP_STATUS, DEVELOPMENT_STATUS } from '../core/status.js';
import { loadKnownBugs } from '../api/bugs.js';
import { awaitsBugApprovalSql } from '../core/bug-trust.js';
import { backfillFailures, detachFromClosedSprints, resumeAfterEnvironment } from './autofix.js';
import { loadProjectContext } from '../core/project-context.js';
import { loadFollowUpContext } from './follow-up.js';
import { markSprintReady, sprintAutopilot } from './sprint-autopilot.js';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { syncRepoDocs } from '../api/docs.js';
import { enterOrderBranch, OrderBranchError, type SprintRef, syncSprintToGit } from './git-sync.js';
import { extractCriteria, loadDefinitions } from './acceptance.js';
import { goLive } from './go-live.js';
import { acquireTree } from '../core/project-lock.js';
import { generateSprintReport } from '../api/reports.js';
import { materializeAttachments } from '../api/attachments.js';
import { selectItems, loadWorkflow, defaultAgentCommand } from './runner-selection.js';
import {
  blockForBudget,
  type BudgetState,
  holdForBudget,
  projectBudgetExceeded,
  releaseBudgetBlocks,
} from './budget.js';
import { setActionTodo } from './action-todo.js';
import { pauseForFolderProblem } from './folder-pause.js';
import { leftItsSprint } from './runner-settle.js';
import {
  claimRun,
  guardedBudgetGate,
  recordBudgetCheckFailure,
  runStep,
  selectWorkflowAgents,
  settleItem,
  runBuiltinAgent,
  type RunContext,
} from './runner-steps.js';
import type { BuiltinAgent, RunnerOptions, WorkItem, WorkflowAgent, WorkItemOptions } from './runner-types.js';

export { PHASE_ORDER, buildPrompt, buildInvocation, agentEnvironment } from './runner-prompts.js';
export {
  parseRunnerOptions,
  loadWorkflow,
  selectItems,
  defaultAgentCommand,
  parseTestCommands,
} from './runner-selection.js';
export { BUDGET_CHECK_RETRY_MS, runBuiltinAgent } from './runner-steps.js';
import type { StepSummary as ResumedStep } from './runner-types.js';
import { currentWorkerId, liveWorkerSql, WORKER_STALE_SECONDS } from './worker-identity.js';

export type {
  BuiltinAgent,
  PromptExtras,
  RunnerOptions,
  StepSummary,
  WorkItem,
  WorkflowAgent,
  WorkItemOptions,
} from './runner-types.js';

const PROMPT_BUG_LIMIT = 15;
// Der Dokumentar schreibt das Benutzerhandbuch ins Projekt und committet es mit dem Auftrag.
const TREE_ROLES = new Set(['developer', 'tester', 'documenter']);

/** Developer, tester, documenter (and every agent of the implementation phase) modify files in the project folder. */
export function changesWorkingTree(agent: Pick<WorkflowAgent, 'phase' | 'role'>): boolean {
  return agent.phase === 'while_task' || TREE_ROLES.has(agent.role);
}

/** Hinweis, wenn ein Auftrag auf den Arbeitsordner wartet (anderer Auftrag, Chat oder Worker hält ihn) – kein Fehler. */
function waitingForTree(itemId: string, cwd: string): () => void {
  return () =>
    console.info(`[${itemId}] wartet auf Arbeitsordner ${cwd} – ein anderer Lauf ändert dort gerade Dateien.`);
}

/**
 * After a failed run only the failed agent and the ones after it run again: leading agents that already passed in the
 * previous run are skipped and their output is handed on to the following agents.
 */
async function resumePosition(
  pool: Pool,
  itemId: string,
  currentRunId: string,
  ordered: WorkflowAgent[],
  done: ResumedStep[],
): Promise<number> {
  const previous = (
    await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_runs WHERE development_id = $1 AND id <> $2 ORDER BY started_at DESC LIMIT 1`,
      [itemId, currentRunId],
    )
  ).rows[0];
  if (previous?.status !== AGENT_RUN_STATUS.failed) return 0;
  const rows = (
    await pool.query<{
      agent_id: string;
      workflow_step_id: string | null;
      agent_name: string;
      phase: string;
      status: string;
      output: string;
      interrupted?: boolean | null;
    }>(
      `SELECT agent_id, workflow_step_id, agent_name, phase, status, output, interrupted
         FROM agent_run_steps WHERE run_id = $1 ORDER BY position`,
      [previous.id],
    )
  ).rows;
  // Schlüssel je Einsatz: derselbe Agent kann im Workflow mehrfach vorkommen.
  const keyOf = (row: { agent_id: string; workflow_step_id: string | null }) => row.workflow_step_id ?? row.agent_id;
  const keyOfAgent = (agent: WorkflowAgent) => agent.stepId ?? agent.id;
  // Nach einer Nachbesserung im Lauf zählt je Einsatz nur sein letzter Schritt – auch wenn der Lauf danach früh
  // abbrach und daher nicht mehr Zeilen als Agents hat. Erkannt wird sie daran, dass ein Einsatz öfter vorkommt als
  // im Ablauf; sonst gilt die Position (derselbe Agent ohne eigenen Workflow-Schritt kann mehrfach vorkommen).
  const latest = new Map(rows.map((row) => [keyOf(row), row]));
  const count = <T>(keys: T[]) =>
    keys.reduce((map, key) => map.set(key, (map.get(key) ?? 0) + 1), new Map<T, number>());
  const planned = count(ordered.map(keyOfAgent));
  const corrected = [...count(rows.map(keyOf))].some(([key, times]) => times > (planned.get(key) ?? times));
  const steps = corrected ? ordered.map((agent) => latest.get(keyOfAgent(agent))) : rows;
  let position = 0;
  while (
    position < ordered.length &&
    steps[position] &&
    ordered[position] &&
    keyOf(steps[position]!) === keyOfAgent(ordered[position]!)
  ) {
    const step = steps[position];
    if (!step) break;
    if (step.status !== AGENT_STEP_STATUS.passed) break;
    done.push({ agentName: step.agent_name, phase: step.phase, status: 'passed', output: step.output });
    position += 1;
  }
  // Lehnen Tester oder Reviewer ab, beginnt der nächste Versuch wieder beim Entwickler – mit deren Rückmeldung.
  // Wurde der Schritt nur unterbrochen (Worker beendet, Ordner weg, Nutzungslimit), setzt derselbe Agent fort.
  const failed = steps[position];
  const failedAgent = ordered[position];
  if (
    failed &&
    failed.status !== AGENT_STEP_STATUS.passed &&
    !failed.interrupted &&
    failedAgent &&
    LOOP_BACK_ROLES.has(failedAgent.role)
  ) {
    const restart = ordered.findIndex((agent) => agent.phase === 'while_task');
    if (restart >= 0 && restart < position) {
      done.splice(restart);
      done.push({
        agentName: failed.agent_name,
        phase: failed.phase,
        status: 'failed',
        output: `Rückmeldung aus dem letzten Versuch – bitte beheben:\n${failed.output}`,
      });
      return restart;
    }
  }
  // If everything passed already, repeat at least the last agent.
  if (position === ordered.length && position > 0) {
    done.pop();
    position -= 1;
  }
  return position;
}

/**
 * Sprint eines Auftrags: Name (Commit-Nachrichten) und festgehaltener Branch (sprints.branch). Der Branch kommt nie aus
 * dem aktuellen Namen – nach einer Umbenennung zweigte sonst ein neuer Sprint-Branch von main ab. Hat ein noch
 * geplanter Sprint keinen (einzelner Agent von Hand), wird er hier einmal vergeben. Ein abgeschlossener oder
 * abgebrochener Sprint zählt nicht: Sein Branch ist schon gesichert, ein Merge dorthin käme nie mehr in main. Der
 * Auftrag arbeitet dann wie einer ohne Sprint auf main.
 */
async function sprintOf(pool: Pool, item: WorkItem): Promise<SprintRef | null> {
  if (!item.sprintId) return null;
  const sprint = await pool
    .query<{ name: string; status: string; branch: string | null }>(
      `WITH fixed AS (
         UPDATE sprints SET branch = sprint_branch_for(project_slug, id, name)
          WHERE id = $1 AND branch IS NULL AND status NOT IN ('completed', 'cancelled') RETURNING id, branch)
       SELECT s.name, s.status, COALESCE(f.branch, s.branch) AS branch
         FROM sprints s LEFT JOIN fixed f ON f.id = s.id WHERE s.id = $1`,
      [item.sprintId],
    )
    .catch(logged('runner', null));
  const row = sprint?.rows[0];
  return typeof row?.name === 'string' && row.status !== 'completed' && row.status !== 'cancelled'
    ? { name: row.name, branch: row.branch ?? null }
    : null;
}

/** Ist der Sprint des Auftrags pausiert? Ein von Hand gestarteter einzelner Agent läuft trotzdem. */
export async function sprintPaused(pool: Pool, item: Pick<WorkItem, 'sprintId' | 'agentId'>): Promise<boolean> {
  if (!item.sprintId || item.agentId) return false;
  const row = (
    await pool.query<{ paused: boolean; status?: string }>(
      'SELECT paused_at IS NOT NULL AS paused, status FROM sprints WHERE id = $1',
      [item.sprintId],
    )
  ).rows[0];
  // Auch ein inzwischen abgeschlossener, abgebrochener oder im Review stehender Sprint hält an: Der Auftrag würde sonst
  // in einen Sprint-Branch gemergt, der schon gesichert ist (Race zwischen „Live schalten“ und Auftragsstart).
  return row?.paused === true || ['completed', 'cancelled', 'review'].includes(row?.status ?? '');
}

/** Rollen, deren Ablehnung den Auftrag zurück zum Entwickler schickt. */
const LOOP_BACK_ROLES = new Set(['tester', 'reviewer']);

export async function runWorkItem(
  pool: Pool,
  item: WorkItem,
  agents: WorkflowAgent[],
  options: WorkItemOptions,
): Promise<'passed' | 'failed' | 'skipped'> {
  const runId = await claimRun(pool, item);
  if (!runId) {
    console.info(`Skipping ${item.id}: a run is already in progress.`);
    return 'skipped';
  }
  heldRuns.add(runId);
  // Ein neuer Lauf hebt eine frühere Budget-Blockade auf; reicht das Budget nicht, setzt die Prüfung sie neu.
  // Der Worker wählt mehrere Aufträge auf einmal und arbeitet sie nacheinander ab: Wurde dieser inzwischen
  // abgelehnt, zurückgestellt, aus dem Sprint genommen oder der Sprint pausiert, startet er nicht (wie selectItems).
  // Ein gezielt gestarteter Auftrag (--item) läuft unabhängig davon, ausser sein Bug stammt aus einer fremden Quelle
  // und ist nicht freigegeben (Prompt-Injection aus Betrieb oder GitHub). Scheitert schon der Start (z. B. Datenbank kurz
  // weg), den Lauf verwerfen: sonst hält er claimRun stundenlang auf.
  const started = await pool
    .query(
      `UPDATE development_items d SET status = '${DEVELOPMENT_STATUS.inProgress}', budget_blocked = NULL, retry_after = NULL, updated_at = NOW()
      WHERE d.id = $1 AND NOT ${awaitsBugApprovalSql('d')} AND ($2 OR (d.status = '${DEVELOPMENT_STATUS.planned}' AND d.kind <> 'express'
        AND (d.retry_after IS NULL OR d.retry_after <= NOW()) AND (
        d.agent_id IS NOT NULL OR (
          NOT EXISTS (SELECT 1 FROM sprints s WHERE s.id = d.sprint_id AND s.paused_at IS NOT NULL)
          AND ((d.auto_run AND d.sprint_id IS NULL) OR EXISTS (SELECT 1 FROM sprints s WHERE s.id = d.sprint_id AND s.status = 'active'))))))`,
      [item.id, Boolean(options.itemId)],
    )
    .catch(async (error: unknown) => {
      await pool.query(`DELETE FROM agent_runs WHERE id = $1`, [runId]).catch(logged('runner'));
      heldRuns.delete(runId);
      throw error;
    });
  if (started.rowCount === 0) {
    await pool.query(`DELETE FROM agent_runs WHERE id = $1`, [runId]).catch(logged('runner'));
    heldRuns.delete(runId);
    console.info(`Skipping ${item.id}: der Auftrag ist nicht mehr eingeplant.`);
    return 'skipped';
  }

  const ordered = selectWorkflowAgents(agents, item);
  const ctx: RunContext = {
    pool,
    item,
    runId,
    options,
    execute: options.execute ?? runCommand,
    builtin: options.builtin ?? runBuiltinAgent,
    done: [],
    bugs: [],
    images: [],
    fallbackCommand: defaultAgentCommand(),
    projectContext: '',
  };
  let passed = true;
  let interrupted = false;
  const startedAt = Date.now();
  const folderAtStart = folderAvailable(options.cwd);
  let budgetStop: BudgetState | null = null;
  // Agents that change the working tree (developer, tester) hold the project lock from their first step until the
  // order is settled, so no other order edits files while this one is tested and committed.
  let releaseTree: (() => void) | undefined;
  try {
    if (!ordered.length) throw new Error('Der zugewiesene Agent ist nicht mehr aktiviert oder vorhanden.');
    // Risks were already filtered by the bug reviewer; otherwise only a short list of known bugs is passed on.
    ctx.bugs = item.risks?.trim()
      ? []
      : await loadKnownBugs(pool, item.projectSlug, PROMPT_BUG_LIMIT).catch(logged('runner', []));
    ctx.images = await materializeAttachments(
      pool,
      { ideationId: item.ideationId, bugId: item.bugId },
      item.id,
      options.cwd,
    ).catch(logged('runner', []));
    // Folgeauftrag: der Kontext des abgeschlossenen Vorgängers gehört zu jeder Agent-Anweisung.
    ctx.projectContext = [
      await loadProjectContext(pool, item.projectSlug),
      await loadFollowUpContext(pool, item.id).catch(() => ''),
    ]
      .filter(Boolean)
      .join('\n\n');
    ctx.definitionOfDone = (await loadDefinitions(pool, item.projectSlug)).done;
    ctx.ordered = ordered;
    ctx.messages = [];
    ctx.sprintNotes = item.sprintId
      ? ((
          await pool
            .query<{ notes: string | null }>(`SELECT pre_sprint_notes AS notes FROM sprints WHERE id = $1`, [
              item.sprintId,
            ])
            .catch(logged('runner', { rows: [] }))
        ).rows[0]?.notes ?? null)
      : null;
    ctx.criteria = extractCriteria(item.description ?? '');
    let position = await resumePosition(pool, item.id, runId, ordered, ctx.done);
    let stepPosition = position;
    let corrected = false;
    const developerAt = ordered.findIndex((agent) => agent.phase === 'while_task');
    while (position < ordered.length) {
      const agent = ordered[position];
      if (!agent) break;
      // Worker wird beendet (Neustart, Abbruch): keinen weiteren Agent starten. Sonst liefe ein neuer CLI-Agent los,
      // während der Shutdown die Kindprozesse beendet – und hinterliesse halbe Commits und index.lock im Ordner.
      if (isShuttingDown()) {
        passed = false;
        interrupted = true;
        break;
      }
      // Sprint pausiert: der vorige Agent hat seinen Schritt beendet, der nächste startet erst nach dem Fortsetzen.
      // Der Auftrag gilt als unterbrochen (wieder „Geplant“); der nächste Lauf überspringt die erfolgreichen Agents.
      if (
        (await sprintPaused(pool, item).catch(logged('runner', false))) ||
        (await leftItsSprint(pool, item).catch(logged('runner', false)))
      ) {
        console.info(`[${item.id}] Sprint pausiert – „${agent.name}“ startet nach dem Fortsetzen.`);
        passed = false;
        interrupted = true;
        break;
      }
      // Budget: Ist ein Limit (Tag, Sprint, Auftrag) des Projekts oder der Rolle des Agents erreicht, startet er nicht.
      // Lässt sich das Budget nicht prüfen (Datenbank kurz weg), startet er auch nicht: Der Auftrag gilt als
      // unterbrochen und startet erst nach einer Pause wieder (retry_after) – kein sofortiger Neustart.
      const budget = await guardedBudgetGate(ctx, agent);
      if (budget.failed) {
        passed = false;
        interrupted = true;
        ctx.stopReason = budget.failed;
        await recordBudgetCheckFailure(ctx, agent, budget.failed, stepPosition).catch(logged('runner'));
        break;
      }
      budgetStop = budget.stop;
      if (budgetStop) {
        passed = false;
        break;
      }
      if (!releaseTree && changesWorkingTree(agent)) {
        releaseTree = await acquireTree(options.cwd, waitingForTree(item.id, options.cwd));
        // Ab dem ersten Agent, der Dateien ändert, arbeitet der Auftrag auf seinem eigenen Branch.
        const sprint = await sprintOf(pool, item);
        ctx.sprintName = sprint?.name ?? null;
        ctx.branch = await enterOrderBranch(options.cwd, item, sprint, ctx.execute);
      }
      const canCorrect =
        !corrected && !item.agentId && LOOP_BACK_ROLES.has(agent.role) && developerAt >= 0 && developerAt < position;
      const outcome = await runStep(ctx, agent, position, ordered.length, { stepPosition, canCorrect });
      stepPosition += 1;
      if (outcome.interrupted) interrupted = true;
      // Budget vor dem neuen Versuch nach einem vorübergehenden Fehler erreicht: anhalten wie vor einem Schritt.
      if (outcome.budget) {
        budgetStop = outcome.budget;
        passed = false;
        break;
      }
      if (!outcome.passed && outcome.correctable && !interrupted) {
        // Einmalige Nachbesserung: ab dem Entwickler erneut, mit der Rückmeldung von Tester oder Reviewer.
        corrected = true;
        const feedback = ctx.done.at(-1);
        ctx.done.splice(developerAt);
        ctx.done.push({
          agentName: agent.name,
          phase: agent.phase,
          status: 'failed',
          output: `Rückmeldung von ${agent.name} – bitte beheben:\n${feedback?.output ?? ''}`,
        });
        position = developerAt;
        continue;
      }
      if (!outcome.passed) {
        passed = false;
        break;
      }
      position += 1;
    }
    // Ende des Auftrags: „Bei abgeschlossen“ bzw. „Bei abgelehnt“ – noch vor dem Abschluss, damit ihre Änderungen im
    // Commit des Auftrags landen. Sie ändern das Ergebnis nicht. Nicht bei Unterbrechung oder Kostenbremse.
    if (!interrupted && !budgetStop && !item.agentId && !isShuttingDown()) {
      const phase = passed ? 'on_done' : 'on_rejected';
      const observers = agents.filter((agent) => agent.phase === phase);
      const last = ctx.done.at(-1);
      const outcome = passed
        ? 'Erledigt: Alle Schritte des Workflows waren erfolgreich.'
        : `Gescheitert bei „${last?.agentName ?? 'einem Agent'}“:\n${last?.output.slice(-1500) ?? ''}`;
      for (const [index, agent] of observers.entries()) {
        // Auch „Bei abgeschlossen/abgelehnt“ starten nicht mehr, wenn das Budget erreicht ist (ohne Blockade).
        // Nur das Limit der eigenen Rolle erreicht: dieser Agent fällt aus, die übrigen laufen.
        // Budget nicht prüfbar: kein weiterer Beobachter startet (das Ergebnis des Auftrags steht schon fest).
        const { stop, failed } = await guardedBudgetGate(ctx, agent);
        if (failed) break;
        if (stop?.role) continue;
        if (stop) break;
        if (!releaseTree && changesWorkingTree(agent)) {
          releaseTree = await acquireTree(options.cwd, waitingForTree(item.id, options.cwd));
          const sprint = await sprintOf(pool, item);
          ctx.sprintName = sprint?.name ?? null;
          ctx.branch = await enterOrderBranch(options.cwd, item, sprint, ctx.execute);
        }
        await runStep(ctx, agent, ordered.length + index, ordered.length + observers.length, {
          stepPosition,
          observer: { outcome },
        });
        stepPosition += 1;
      }
    }
  } catch (error) {
    passed = false;
    // Z. B. git im Projektordner scheitert, weil das Laufwerk kurz weg war: erneut einplanen statt blockieren.
    if (folderAtStart && hadOutage(options.cwd, startedAt)) interrupted = true;
    // Worker wird beendet (z. B. während der Auftrag auf den Arbeitsordner wartete): unterbrochen, nicht blockiert.
    else if (isShuttingDown()) interrupted = true;
    else if (error instanceof OrderBranchError) {
      // Der Arbeitsordner ist nicht sauber (fremde Änderungen, falscher Branch): Das betrifft jeden Auftrag, nicht
      // diesen. Also nicht blockieren, sondern eingeplant lassen und den Sprint pausieren – sonst scheiterte ein
      // Auftrag nach dem anderen (Sprint 20: 18 Aufträge in vier Minuten) und der Autopilot hielte sie für erledigt.
      interrupted = true;
      ctx.stopReason = error.message;
      await pauseForFolderProblem(pool, item, error.message).catch(logged('runner'));
    } else {
      // Unerwarteter Fehler: Der Auftrag wird blockiert – nie ohne Begründung (sonst stünde sie nur im Worker-Log).
      const message = error instanceof Error ? error.message : String(error);
      ctx.stopReason = `Lauf abgebrochen: ${message}`;
      await pool
        .query(`UPDATE development_items SET failure = $2 WHERE id = $1`, [item.id, ctx.stopReason])
        .catch(logged('runner'));
    }
    console.error(`Run ${runId} aborted:`, error);
  } finally {
    if (budgetStop) {
      const todo = await blockForBudget(pool, item.id, budgetStop).catch(logged('runner', null));
      console.info(`[${item.id}] ${todo ?? 'Budget erreicht'}`);
      if (todo) await setActionTodo(pool, item.id, todo).catch(logged('runner'));
      ctx.stopReason = todo;
    }
    // Erst den Auftrag abschliessen, dann den Lauf: Stirbt der Worker dazwischen, gilt der Lauf als unterbrochen und
    // recoverInterruptedRuns plant den Auftrag wieder ein. Jeder Schritt ist einzeln abgesichert, damit ein kurzer
    // Datenbank-Aussetzer den Auftrag nicht „In Arbeit“ hängen lässt. settleItem selbst wird nicht wiederholt (Merge
    // und Commit liefen sonst doppelt); nur die reinen Datenbank-Schritte danach, mit Pause.
    const retryDelay = options.settleRetryDelayMs ?? SETTLE_RETRY_DELAY_MS;
    let settleFailed = false;
    try {
      await settleItem(ctx, passed, interrupted);
    } catch (error) {
      passed = false;
      settleFailed = true;
      console.error(`[${item.id}] Abschluss fehlgeschlagen:`, error);
    } finally {
      releaseTree?.();
    }
    try {
      if (settleFailed) await retryOnDatabase(() => blockStuckItem(pool, item.id), retryDelay).catch(logged('runner'));
      await retryOnDatabase(
        () =>
          pool.query(`UPDATE agent_runs SET status = $2, completed_at = NOW() WHERE id = $1`, [
            runId,
            passed ? AGENT_RUN_STATUS.passed : AGENT_RUN_STATUS.failed,
          ]),
        retryDelay,
      ).catch(logged('runner'));
    } finally {
      // Ab hier hält dieser Worker den Lauf nicht mehr: Blieb er trotz allem „läuft“, räumt closeOrphanedRuns ihn auf.
      heldRuns.delete(runId);
    }
  }
  return passed ? AGENT_RUN_STATUS.passed : AGENT_RUN_STATUS.failed;
}

/** Läufe, die dieser Worker gerade selbst ausführt (von claimRun bis zum Schliessen des Laufs). */
const heldRuns = new Set<string>();

export function heldRunIds(): string[] {
  return [...heldRuns];
}

/** Pause zwischen den Versuchen, einen Auftrag nach einem Datenbankfehler abzuschliessen. */
export const SETTLE_RETRY_DELAY_MS = 15_000;
const SETTLE_ATTEMPTS = 5;

/** Datenbank nicht erreichbar (Verbindung abgelehnt, getrennt, Server fährt herunter) – im Gegensatz zu SQL-Fehlern. */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message, errors } = error as { code?: unknown; message?: unknown; errors?: unknown };
  // pg meldet eine ausgefallene Datenbank oft als AggregateError (IPv4 und IPv6), der Code steckt dann in errors.
  if (Array.isArray(errors) && errors.some(isDatabaseUnavailable)) return true;
  if (typeof code === 'string' && DATABASE_DOWN_CODES.test(code)) return true;
  return typeof message === 'string' && DATABASE_DOWN_MESSAGES.test(message);
}

const DATABASE_DOWN_CODES = /^(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|08\w{3}|57P0[1-3])$/;
const DATABASE_DOWN_MESSAGES = /Connection terminated|connect ECONNREFUSED|timeout exceeded when trying to connect/i;

/** Wiederholt `work` bei Datenbankausfall einige Male mit Pause; andere Fehler gehen sofort weiter. */
export async function retryOnDatabase<T>(
  work: () => Promise<T>,
  delayMs: number,
  attempts = SETTLE_ATTEMPTS,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= attempts || !isDatabaseUnavailable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** Hinweis an Aufträgen, deren Abschluss nicht durchlief (kein Code-Fehler, daher kein Bug-Bericht). */
export const STUCK_FAILURE =
  'Der Abschluss des Auftrags wurde unterbrochen (z. B. Datenbank kurz nicht erreichbar). Bitte erneut starten.';

/** Auftrag, dessen Abschluss scheiterte: blockiert statt dauerhaft „In Arbeit“. */
async function blockStuckItem(pool: Pool, itemId: string): Promise<void> {
  await pool.query(
    `UPDATE development_items SET status = '${DEVELOPMENT_STATUS.blocked}', failure = COALESCE(failure, $2), updated_at = NOW()
      WHERE id = $1 AND status = '${DEVELOPMENT_STATUS.inProgress}'`,
    [itemId, STUCK_FAILURE],
  );
}

/**
 * Aufträge „In Arbeit“ ohne laufenden Lauf hängen (Abschluss scheiterte, Worker starb zwischen Lauf und Abschluss):
 * blockieren, damit sie sichtbar sind und erneut gestartet werden können. Läuft am Anfang jedes Zyklus (je Projekt)
 * und beim Start des Workers (alle Projekte). Express-Aufträge aus dem Chat haben keine Läufe und bleiben unberührt.
 */
export async function recoverStuckItems(pool: Pool, project: string | null): Promise<number> {
  const result = await pool.query(
    `UPDATE development_items d SET status = '${DEVELOPMENT_STATUS.blocked}', failure = COALESCE(d.failure, $2), updated_at = NOW()
      WHERE d.status = '${DEVELOPMENT_STATUS.inProgress}' AND ($1::text IS NULL OR d.project_slug = $1)
        AND EXISTS (SELECT 1 FROM agent_runs r WHERE r.development_id = d.id)
        AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.development_id = d.id AND r.status = '${AGENT_RUN_STATUS.running}')`,
    [project, STUCK_FAILURE],
  );
  return result.rowCount ?? 0;
}

/** So lange ohne Lebenszeichen gilt ein Lauf, den dieser Worker nicht hält, als verwaist. */
export const ORPHANED_RUN_MS = 5 * 60_000;
/** Abgebrochener Schritt eines verwaisten Laufs: kurze Schonfrist nur gegen den Moment zwischen claimRun und Merken. */
export const ORPHANED_CANCEL_MS = 30_000;
/** So oft darf ein Auftrag verwaisen und wieder eingeplant werden; danach wird er blockiert statt endlos neu gestartet. */
export const ORPHANED_REQUEUE_LIMIT = 2;

export const ORPHANED_RUN_NOTE =
  'Unterbrochen: Der Lauf hatte keinen Prozess mehr (Abschluss scheiterte, z. B. Datenbank nicht erreichbar).';
export const ORPHANED_CANCEL_NOTE =
  'Vom Benutzer abgebrochen. Der Lauf hatte keinen Prozess mehr – der Schritt wurde vom Worker direkt beendet.';

/**
 * Läufe „läuft“, die kein Auftrag dieses Workers mehr hält (Abschluss oder Lauf-Status scheiterten an der Datenbank):
 * wie beim Start aufräumen, ohne Neustart. Schritte werden „Unterbrochen“, der Auftrag wieder eingeplant (höchstens
 * ORPHANED_REQUEUE_LIMIT-mal, danach blockiert). Ein abgebrochener Schritt („Abbrechen“) endet sofort, der Auftrag
 * wird blockiert wie bei cancelAgent. Nur Läufe der eigenen Projekte und ohne frisches Lebenszeichen (Start des Laufs
 * oder eines Schritts, Eintrag im Verlauf) und nicht von einem anderen, lebenden Worker. Eine einzige Anweisung: alles
 * oder nichts, mehrfach ausführbar.
 */
export async function closeOrphanedRuns(
  pool: Pool,
  projects: string[],
  held: string[] = heldRunIds(),
  staleMs = ORPHANED_RUN_MS,
  workerId: string | null = currentWorkerId(),
): Promise<number> {
  if (!projects.length) return 0;
  const result = await pool.query<{ count: number }>(
    `WITH candidates AS (
       SELECT r.id, r.development_id,
              EXISTS (SELECT 1 FROM agent_run_steps c
                       WHERE c.run_id = r.id AND c.status = '${AGENT_STEP_STATUS.running}' AND c.cancel_requested) AS cancelled,
              GREATEST(
                r.started_at,
                (SELECT MAX(s.started_at) FROM agent_run_steps s WHERE s.run_id = r.id),
                (SELECT MAX((event->>'at')::timestamptz)
                   FROM agent_run_steps s CROSS JOIN LATERAL jsonb_array_elements(s.events) event WHERE s.run_id = r.id)
              ) AS alive_at
         FROM agent_runs r
        WHERE r.status = '${AGENT_RUN_STATUS.running}' AND r.project_slug = ANY($1::text[])
          AND NOT (r.id::text = ANY($2::text[]))
          -- Läufe eines anderen, lebenden Workers räumt dieser selbst auf.
          AND (r.worker_id IS NULL OR r.worker_id = $9 OR NOT ${liveWorkerSql('r.worker_id', '$10')})
     ), orphans AS (
       SELECT * FROM candidates
        WHERE alive_at < NOW() - (CASE WHEN cancelled THEN $4::bigint ELSE $3::bigint END) * INTERVAL '1 millisecond'
     ), runs AS (
       UPDATE agent_runs r SET status = '${AGENT_RUN_STATUS.failed}', completed_at = NOW()
         FROM orphans o WHERE r.id = o.id AND r.status = '${AGENT_RUN_STATUS.running}'
       RETURNING r.id, o.development_id, o.cancelled
     ), steps AS (
       UPDATE agent_run_steps s SET status = '${AGENT_STEP_STATUS.failed}', interrupted = NOT runs.cancelled,
              exit_code = CASE WHEN runs.cancelled THEN 130 ELSE s.exit_code END,
              output = COALESCE(NULLIF(s.output, '') || E'\\n', '') || CASE WHEN runs.cancelled THEN $6 ELSE $5 END
         FROM runs WHERE s.run_id = runs.id AND s.status = '${AGENT_STEP_STATUS.running}'
       RETURNING s.id
     ), settled AS (
       SELECT runs.development_id, runs.cancelled OR (
                SELECT count(*) FROM agent_run_steps p JOIN agent_runs pr ON pr.id = p.run_id
                 WHERE pr.development_id = runs.development_id AND p.output LIKE '%' || $5) >= $7 AS block
         FROM runs
     ), items AS (
       UPDATE development_items d SET updated_at = NOW(),
              status = CASE WHEN st.block THEN '${DEVELOPMENT_STATUS.blocked}' ELSE '${DEVELOPMENT_STATUS.planned}' END,
              failure = CASE WHEN st.block THEN COALESCE(d.failure, $8) ELSE d.failure END
         FROM settled st WHERE d.id = st.development_id AND d.status = '${DEVELOPMENT_STATUS.inProgress}'
       RETURNING d.id
     )
     SELECT (SELECT count(*) FROM runs)::int AS count`,
    [
      projects,
      held,
      staleMs,
      ORPHANED_CANCEL_MS,
      ORPHANED_RUN_NOTE,
      ORPHANED_CANCEL_NOTE,
      ORPHANED_REQUEUE_LIMIT,
      STUCK_FAILURE,
      workerId,
      WORKER_STALE_SECONDS,
    ],
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * Tages- oder Sprintbudget erreicht? Dann wartet `item` mit „Aktion notwendig: Budget“ (höchstens einer je Projekt,
 * siehe holdForBudget) und es startet kein weiterer Auftrag.
 */
export function budgetHold(pool: Pool, project: string): (item: WorkItem) => Promise<boolean> {
  return async (item) => {
    const exhausted = await projectBudgetExceeded(pool, project).catch(logged('runner', null));
    if (!exhausted) return false;
    await holdForBudget(pool, item, exhausted).catch(logged('runner'));
    return true;
  };
}

/**
 * Streng nacheinander: ein Auftrag nach dem anderen (jeder auf seinem Branch, Commit nach jedem Agent). Scheitert
 * einer unerwartet (z. B. inzwischen gelöscht), laufen die übrigen trotzdem.
 */
export async function runSelectedItems(
  items: WorkItem[],
  run: (item: WorkItem) => Promise<string>,
  between: () => Promise<unknown> = async () => undefined,
  heldForBudget: (item: WorkItem) => Promise<boolean> = async () => false,
): Promise<{ itemId: string; result: string }[]> {
  const results: { itemId: string; result: string }[] = [];
  for (const item of items) {
    // Neustart steht an: keinen weiteren Auftrag beginnen, der dann mitten im Schritt beendet würde.
    if (isShuttingDown() || isDraining()) break;
    if (results.length) {
      await between().catch(logged('runner'));
      // Budget während des Zyklus erreicht: nur der nächste Auftrag wartet sichtbar, die übrigen bleiben eingeplant.
      if (await heldForBudget(item)) break;
    }
    const result = await run(item).catch((error: unknown) => {
      console.error(`Auftrag ${item.id} abgebrochen:`, error);
      return AGENT_RUN_STATUS.failed;
    });
    results.push({ itemId: item.id, result });
  }
  return results;
}

export async function runWorkflow(
  pool: Pool,
  options: RunnerOptions,
  execute?: CommandExecutor,
  builtin?: BuiltinAgent,
): Promise<{ itemId: string; result: string }[]> {
  // Neustart steht an: weder Git-Sicherung (Test-Gate) noch Autopilot noch Aufträge starten.
  if (isDraining()) return [];
  await syncSprintToGit(pool, options.project, options.cwd, execute, () =>
    goLive(pool, options.project, options.cwd, execute),
  );
  // Orders in the active sprint run automatically, even when they are still in the backlog.
  await pool.query(
    `UPDATE development_items SET status = '${DEVELOPMENT_STATUS.planned}', updated_at = NOW()
      WHERE project_slug = $1 AND status = '${DEVELOPMENT_STATUS.backlog}' AND sprint_id IN (SELECT id FROM sprints WHERE project_slug = $1 AND status = 'active')`,
    [options.project],
  );
  await resumeAfterEnvironment(pool, options.project, options.cwd).catch(logged('runner'));
  // Hängengebliebene Aufträge (Abschluss scheiterte) nicht erst beim nächsten Worker-Start aufräumen.
  await recoverStuckItems(pool, options.project).catch(logged('runner', 0));
  // Budget wieder frei (Folgetag, Limit erhöht oder entfernt): wegen Budget blockierte Aufträge laufen weiter.
  await releaseBudgetBlocks(pool, options.project).catch(logged('runner', []));
  // Erst danach: Was eben neu eingeplant wurde, aber noch an einem geschlossenen Sprint hängt, kommt in den aktiven.
  await detachFromClosedSprints(pool, options.project).catch(logged('runner', 0));
  // Freigegebene Aufträge (Review-Freigabe) zwischen zwei Aufträgen mergen; danach ggf. deployen.
  await processApprovals(pool, options.project, options.cwd, execute).catch((error) => {
    console.error('Freigabe fehlgeschlagen:', error);
    return 0;
  });
  // Sprint fertig? Dann wartet er auf das Go (Vorschau ansehen, „Live schalten“).
  await markSprintReady(pool, options.project).catch((error) => console.error('Sprint-Review fehlgeschlagen:', error));
  // Autopilot: nach dem Go den nächsten Sprint vorschlagen und starten.
  await sprintAutopilot(pool, options.project).catch((error) =>
    console.error('Sprint-Autopilot fehlgeschlagen:', error),
  );
  await backfillFailures(pool, options.project).catch((error) =>
    console.error('Fehler-Nachtrag fehlgeschlagen:', error),
  );
  const results: { itemId: string; result: string }[] = [];
  const agents = await loadWorkflow(pool, options.project);
  // „Vor dem Sprint“: einmal je Sprint, bevor dessen Aufträge starten (diese laufen dann im nächsten Zyklus).
  if (await runPreSprint(pool, options, agents, execute)) return results;
  const items = await selectItems(pool, options);
  if (!items.length) {
    return results;
  }
  if (!agents.length) {
    throw new Error('Kein aktivierter Agent vorhanden. Im Agents-Menü Agents anlegen oder aktivieren.');
  }
  // Tages- oder Sprintbudget erreicht: kein neuer Lauf. Der nächste Auftrag zeigt „Aktion notwendig: Budget“.
  const held = budgetHold(pool, options.project);
  if (items[0] && (await held(items[0]))) return results;
  results.push(
    ...(await runSelectedItems(
      items,
      (item) => runWorkItem(pool, item, agents, { ...options, execute, builtin }),
      // Angeforderte Live-Schaltungen (Git-Sicherung) nicht hinter dem ganzen Durchlauf warten lassen: zwischen zwei
      // Aufträgen erledigen, der Ordner ist dann sauber. Vor dem ersten Auftrag lief sie oben schon.
      () =>
        syncSprintToGit(pool, options.project, options.cwd, execute, () =>
          goLive(pool, options.project, options.cwd, execute),
        ),
      held,
    )),
  );
  // Nach Beginn des Shutdowns weder Doku-Abgleich noch Git-Sicherung (Test-Gate, Merge, Push) beginnen.
  if (isShuttingDown()) return results;
  await syncRepoDocs(pool, options.project, options.cwd);
  const active = await pool.query<{ id: string }>(
    `SELECT id FROM sprints WHERE project_slug = $1 AND status = 'active'`,
    [options.project],
  );
  if (active.rows[0]) {
    await generateSprintReport(pool, active.rows[0].id);
  }
  await syncSprintToGit(pool, options.project, options.cwd, execute, () =>
    goLive(pool, options.project, options.cwd, execute),
  );
  return results;
}
