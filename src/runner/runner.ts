import type { Pool } from 'pg';
import { AGENT_RUN_STATUS, DEVELOPMENT_STATUS } from '../core/status.js';
import { loadKnownBugs } from '../api/bugs.js';
import { backfillFailures } from './autofix.js';
import { loadProjectContext } from '../core/project-context.js';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { syncRepoDocs } from '../api/docs.js';
import { syncSprintToGit } from './git-sync.js';
import { estimateIdeas } from '../agent/estimation.js';
import { draftRequirements } from '../agent/requirements.js';
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
export type {
  BuiltinAgent,
  PromptExtras,
  RunnerOptions,
  StepSummary,
  WorkItem,
  WorkflowAgent,
  WorkItemOptions,
} from './runner-types.js';

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
    ctx.images = await materializeAttachments(pool, item.ideationId, item.id, options.cwd).catch(() => []);
    ctx.projectContext = await loadProjectContext(pool, item.projectSlug);
    for (const [position, agent] of ordered.entries()) {
      const outcome = await runStep(ctx, agent, position, ordered.length);
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
  await estimateIdeas(pool, options, execute);
  await draftRequirements(pool, options, execute);
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
  for (const item of items) {
    results.push({ itemId: item.id, result: await runWorkItem(pool, item, agents, { ...options, execute, builtin }) });
  }
  await syncRepoDocs(pool, options.project, options.cwd);
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
