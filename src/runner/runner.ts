import { logged } from '../core/log.js';
import { isShuttingDown } from '../core/shutdown.js';
import { runPreSprint } from './pre-sprint.js';
import { processApprovals } from './review-gate.js';
import { folderAvailable, hadOutage } from '../core/folder-guard.js';
import type { Pool } from 'pg';
import { AGENT_RUN_STATUS, AGENT_STEP_STATUS, DEVELOPMENT_STATUS } from '../core/status.js';
import { loadKnownBugs } from '../api/bugs.js';
import { backfillFailures, resumeAfterEnvironment } from './autofix.js';
import { loadProjectContext } from '../core/project-context.js';
import { loadFollowUpContext } from './follow-up.js';
import { markSprintReady, sprintAutopilot } from './sprint-autopilot.js';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { syncRepoDocs } from '../api/docs.js';
import { enterOrderBranch, OrderBranchError, syncSprintToGit } from './git-sync.js';
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
import {
  budgetGate,
  claimRun,
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
export { runBuiltinAgent } from './runner-steps.js';
import type { StepSummary as ResumedStep } from './runner-types.js';

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
const TREE_ROLES = new Set(['developer', 'tester']);

/** Developer and tester (and every agent of the implementation phase) modify files in the project folder. */
export function changesWorkingTree(agent: Pick<WorkflowAgent, 'phase' | 'role'>): boolean {
  return agent.phase === 'while_task' || TREE_ROLES.has(agent.role);
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
    }>(
      `SELECT agent_id, workflow_step_id, agent_name, phase, status, output
         FROM agent_run_steps WHERE run_id = $1 ORDER BY position`,
      [previous.id],
    )
  ).rows;
  // Schlüssel je Einsatz: derselbe Agent kann im Workflow mehrfach vorkommen.
  const keyOf = (row: { agent_id: string; workflow_step_id: string | null }) => row.workflow_step_id ?? row.agent_id;
  const keyOfAgent = (agent: WorkflowAgent) => agent.stepId ?? agent.id;
  // Nach einer Nachbesserung im Lauf zählt je Einsatz nur sein letzter Schritt.
  const latest = new Map(rows.map((row) => [keyOf(row), row]));
  const steps = rows.length > ordered.length ? ordered.map((agent) => latest.get(keyOfAgent(agent))) : rows;
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
  const failed = steps[position];
  const failedAgent = ordered[position];
  if (failed && failed.status !== AGENT_STEP_STATUS.passed && failedAgent && LOOP_BACK_ROLES.has(failedAgent.role)) {
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

/** Name des Sprints eines Auftrags (für Sprint-Branch und Commit-Nachrichten). */
async function sprintNameOf(pool: Pool, item: WorkItem): Promise<string | null> {
  if (!item.sprintId) return null;
  const sprint = await pool
    .query<{ name: string }>('SELECT name FROM sprints WHERE id = $1', [item.sprintId])
    .catch(logged('runner', null));
  return sprint?.rows[0]?.name ?? null;
}

/** Ist der Sprint des Auftrags pausiert? Ein von Hand gestarteter einzelner Agent läuft trotzdem. */
export async function sprintPaused(pool: Pool, item: Pick<WorkItem, 'sprintId' | 'agentId'>): Promise<boolean> {
  if (!item.sprintId || item.agentId) return false;
  const row = (
    await pool.query<{ paused: boolean }>('SELECT paused_at IS NOT NULL AS paused FROM sprints WHERE id = $1', [
      item.sprintId,
    ])
  ).rows[0];
  return row?.paused === true;
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
  // Ein neuer Lauf hebt eine frühere Budget-Blockade auf; reicht das Budget nicht, setzt die Prüfung sie neu.
  await pool.query(
    `UPDATE development_items SET status = '${DEVELOPMENT_STATUS.inProgress}', budget_blocked = NULL, updated_at = NOW()
      WHERE id = $1`,
    [item.id],
  );

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
      // Sprint pausiert: der vorige Agent hat seinen Schritt beendet, der nächste startet erst nach dem Fortsetzen.
      // Der Auftrag gilt als unterbrochen (wieder „Geplant“); der nächste Lauf überspringt die erfolgreichen Agents.
      if (await sprintPaused(pool, item).catch(logged('runner', false))) {
        console.info(`[${item.id}] Sprint pausiert – „${agent.name}“ startet nach dem Fortsetzen.`);
        passed = false;
        interrupted = true;
        break;
      }
      // Budget: Ist ein Limit (Tag, Sprint, Auftrag) erreicht, startet kein weiterer Agent.
      budgetStop = await budgetGate(ctx).catch(logged('runner', null));
      if (budgetStop) {
        passed = false;
        break;
      }
      if (!releaseTree && changesWorkingTree(agent)) {
        releaseTree = await acquireTree(options.cwd);
        // Ab dem ersten Agent, der Dateien ändert, arbeitet der Auftrag auf seinem eigenen Branch.
        ctx.sprintName = await sprintNameOf(pool, item);
        ctx.branch = await enterOrderBranch(options.cwd, item, ctx.sprintName, ctx.execute);
      }
      const canCorrect =
        !corrected && !item.agentId && LOOP_BACK_ROLES.has(agent.role) && developerAt >= 0 && developerAt < position;
      const outcome = await runStep(ctx, agent, position, ordered.length, { stepPosition, canCorrect });
      stepPosition += 1;
      if (outcome.interrupted) interrupted = true;
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
    if (!interrupted && !budgetStop && !item.agentId) {
      const phase = passed ? 'on_done' : 'on_rejected';
      const observers = agents.filter((agent) => agent.phase === phase);
      const last = ctx.done.at(-1);
      const outcome = passed
        ? 'Erledigt: Alle Schritte des Workflows waren erfolgreich.'
        : `Gescheitert bei „${last?.agentName ?? 'einem Agent'}“:\n${last?.output.slice(-1500) ?? ''}`;
      for (const [index, agent] of observers.entries()) {
        // Auch „Bei abgeschlossen/abgelehnt“ starten nicht mehr, wenn das Budget erreicht ist (ohne Blockade).
        if (await budgetGate(ctx).catch(logged('runner', null))) break;
        if (!releaseTree && changesWorkingTree(agent)) {
          releaseTree = await acquireTree(options.cwd);
          ctx.sprintName = await sprintNameOf(pool, item);
          ctx.branch = await enterOrderBranch(options.cwd, item, ctx.sprintName, ctx.execute);
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
    else if (error instanceof OrderBranchError) {
      // Kein eigener Branch: der Auftrag wartet auf einen Menschen, statt auf einem fremden Branch zu committen.
      ctx.stopReason = error.message;
      await setActionTodo(pool, item.id, 'Arbeitsordner aufräumen (Git)').catch(logged('runner'));
      await pool
        .query(`UPDATE development_items SET failure = $2 WHERE id = $1`, [item.id, error.message])
        .catch(logged('runner'));
    }
    console.error(`Run ${runId} aborted:`, error);
  } finally {
    await pool.query(`UPDATE agent_runs SET status = $2, completed_at = NOW() WHERE id = $1`, [
      runId,
      passed ? AGENT_RUN_STATUS.passed : AGENT_RUN_STATUS.failed,
    ]);
    if (budgetStop) {
      const todo = await blockForBudget(pool, item.id, budgetStop).catch(logged('runner', null));
      console.info(`[${item.id}] ${todo ?? 'Budget erreicht'}`);
      if (todo) await setActionTodo(pool, item.id, todo).catch(logged('runner'));
      ctx.stopReason = todo;
    }
    try {
      await settleItem(ctx, passed, interrupted);
    } finally {
      releaseTree?.();
    }
  }
  return passed ? AGENT_RUN_STATUS.passed : AGENT_RUN_STATUS.failed;
}

export async function runWorkflow(
  pool: Pool,
  options: RunnerOptions,
  execute?: CommandExecutor,
  builtin?: BuiltinAgent,
): Promise<{ itemId: string; result: string }[]> {
  await syncSprintToGit(pool, options.project, options.cwd, execute, () =>
    goLive(pool, options.project, options.cwd, execute),
  );
  // Orders in the active sprint run automatically, even when they are still in the backlog.
  await pool.query(
    `UPDATE development_items SET status = '${DEVELOPMENT_STATUS.planned}', updated_at = NOW()
      WHERE project_slug = $1 AND status = '${DEVELOPMENT_STATUS.backlog}' AND sprint_id IN (SELECT id FROM sprints WHERE project_slug = $1 AND status = 'active')`,
    [options.project],
  );
  await resumeAfterEnvironment(pool, options.project).catch(logged('runner'));
  // Budget wieder frei (Folgetag, Limit erhöht oder entfernt): wegen Budget blockierte Aufträge laufen weiter.
  await releaseBudgetBlocks(pool, options.project).catch(logged('runner', []));
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
  const exhausted = await projectBudgetExceeded(pool, options.project).catch(logged('runner', null));
  if (exhausted && items[0]) {
    await holdForBudget(pool, items[0], exhausted).catch(logged('runner'));
    return results;
  }
  // Streng nacheinander: ein Auftrag nach dem anderen (jeder auf seinem Branch, Commit nach jedem Agent).
  for (const item of items) {
    if (isShuttingDown()) break;
    // Angeforderte Live-Schaltungen (Git-Sicherung) nicht hinter dem ganzen Durchlauf warten lassen: zwischen zwei
    // Aufträgen erledigen, der Ordner ist dann sauber. Vor dem ersten Auftrag lief sie oben schon.
    if (results.length) {
      await syncSprintToGit(pool, options.project, options.cwd, execute, () =>
        goLive(pool, options.project, options.cwd, execute),
      ).catch(logged('runner'));
    }
    results.push({
      itemId: item.id,
      result: await runWorkItem(pool, item, agents, { ...options, execute, builtin }),
    });
  }
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
