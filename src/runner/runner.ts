import type { Pool } from 'pg';
import { AGENT_RUN_STATUS, AGENT_STEP_STATUS, DEVELOPMENT_STATUS } from '../core/status.js';
import { loadKnownBugs } from '../api/bugs.js';
import { backfillFailures } from './autofix.js';
import { loadProjectContext } from '../core/project-context.js';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { syncRepoDocs } from '../api/docs.js';
import { syncSprintToGit } from './git-sync.js';
import { deployProject } from './deploy.js';
import { Mutex } from '../core/mutex.js';
import { generateSprintReport } from '../api/reports.js';
import { materializeAttachments } from '../api/attachments.js';
import { selectItems, loadWorkflow, defaultAgentCommand } from './runner-selection.js';
import {
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
  const steps = (
    await pool.query<{ agent_id: string; agent_name: string; phase: string; status: string; output: string }>(
      `SELECT agent_id, agent_name, phase, status, output FROM agent_run_steps WHERE run_id = $1 ORDER BY position`,
      [previous.id],
    )
  ).rows;
  let position = 0;
  while (position < ordered.length && steps[position]?.agent_id === ordered[position]?.id) {
    const step = steps[position]!;
    if (step.status !== AGENT_STEP_STATUS.passed) break;
    done.push({ agentName: step.agent_name, phase: step.phase, status: 'passed', output: step.output });
    position += 1;
  }
  // If everything passed already, repeat at least the last agent.
  if (position === ordered.length && position > 0) {
    done.pop();
    position -= 1;
  }
  return position;
}

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
  await pool.query(
    `UPDATE development_items SET status = '${DEVELOPMENT_STATUS.inProgress}', updated_at = NOW() WHERE id = $1`,
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
  try {
    if (!ordered.length) throw new Error('Der zugewiesene Agent ist nicht mehr aktiviert oder vorhanden.');
    ctx.bugs = await loadKnownBugs(pool, item.projectSlug).catch(() => []);
    ctx.images = await materializeAttachments(
      pool,
      { ideationId: item.ideationId, bugId: item.bugId },
      item.id,
      options.cwd,
    ).catch(() => []);
    ctx.projectContext = await loadProjectContext(pool, item.projectSlug);
    const resumeFrom = await resumePosition(pool, item.id, runId, ordered, ctx.done);
    for (const [position, agent] of ordered.entries()) {
      if (position < resumeFrom) continue;
      // Developer and tester change the working tree, so they never overlap; author and documentation agents may.
      const release = agent.phase === 'while_task' ? await options.implementationLock?.acquire() : undefined;
      let outcome: Awaited<ReturnType<typeof runStep>>;
      try {
        outcome = await runStep(ctx, agent, position, ordered.length);
      } finally {
        release?.();
      }
      if (outcome.interrupted) interrupted = true;
      if (!outcome.passed) {
        passed = false;
        break;
      }
    }
  } catch (error) {
    passed = false;
    console.error(`Run ${runId} aborted:`, error);
  } finally {
    await pool.query(`UPDATE agent_runs SET status = $2, completed_at = NOW() WHERE id = $1`, [
      runId,
      passed ? AGENT_RUN_STATUS.passed : AGENT_RUN_STATUS.failed,
    ]);
    await settleItem(ctx, passed, interrupted);
  }
  return passed ? AGENT_RUN_STATUS.passed : AGENT_RUN_STATUS.failed;
}

export async function runWorkflow(
  pool: Pool,
  options: RunnerOptions,
  execute?: CommandExecutor,
  builtin?: BuiltinAgent,
): Promise<{ itemId: string; result: string }[]> {
  await syncSprintToGit(pool, options.project, options.cwd, execute);
  // Orders in the active sprint run automatically, even when they are still in the backlog.
  await pool.query(
    `UPDATE development_items SET status = '${DEVELOPMENT_STATUS.planned}', updated_at = NOW()
      WHERE project_slug = $1 AND status = '${DEVELOPMENT_STATUS.backlog}' AND sprint_id IN (SELECT id FROM sprints WHERE project_slug = $1 AND status = 'active')`,
    [options.project],
  );
  await backfillFailures(pool, options.project).catch((error) =>
    console.error('Fehler-Nachtrag fehlgeschlagen:', error),
  );
  const items = await selectItems(pool, options);
  const results: { itemId: string; result: string }[] = [];
  if (!items.length) {
    return results;
  }
  const agents = await loadWorkflow(pool, options.project);
  if (!agents.length) {
    throw new Error('Kein aktivierter Agent vorhanden. Im Agents-Menü Agents anlegen oder aktivieren.');
  }
  const implementationLock = new Mutex();
  results.push(
    ...(await Promise.all(
      items.map(async (item) => ({
        itemId: item.id,
        result: await runWorkItem(pool, item, agents, { ...options, execute, builtin, implementationLock }),
      })),
    )),
  );
  await syncRepoDocs(pool, options.project, options.cwd);
  if (results.some(({ result }) => result === 'passed')) {
    await deployProject(pool, options.project, options.cwd, execute).catch((error) =>
      console.error('Deploy fehlgeschlagen:', error),
    );
  }
  const active = await pool.query<{ id: string }>(
    `SELECT id FROM sprints WHERE project_slug = $1 AND status = 'active'`,
    [options.project],
  );
  if (active.rows[0]) {
    await generateSprintReport(pool, active.rows[0].id);
  }
  await syncSprintToGit(pool, options.project, options.cwd, execute);
  return results;
}
