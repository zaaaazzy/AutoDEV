import type { Pool } from 'pg';
import type { KnownBug } from '../api/bugs.js';
import { withProjectContext } from '../core/project-context.js';
import { AGENT_RUN_STATUS, AGENT_STEP_STATUS, DEVELOPMENT_STATUS } from '../core/status.js';
import { registerFailure, resumeBlockedByBug } from './autofix.js';
import { startProgress } from '../agent/chat-progress.js';
import { isShuttingDown, killGroup } from '../core/shutdown.js';
import { type CommandExecutor, type CommandResult, redactOutput } from '../core/command.js';
import { readManual, saveOrderDoc, upsertDoc } from '../api/docs.js';
import { commitTaskToGit } from './git-sync.js';
import { runOllamaAgent } from '../agent/ollama-agent.js';
import { runTestAgent } from './test-agent.js';
import { agentEnvironment, buildInvocation, buildPrompt, PHASE_ORDER } from './runner-prompts.js';
import type { BuiltinAgent, StepSummary, WorkItem, WorkflowAgent, WorkItemOptions } from './runner-types.js';
import { parseTestCommands } from './runner-selection.js';

const MANUAL_TITLE = 'Anwendungshandbuch';
const USER_MANUAL_TITLE = 'Benutzerhandbuch';
const MIN_MANUAL_CHARS = 200;

async function testCommands(
  pool: Pool,
  project: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string[][]> {
  const stored = (
    await pool.query<{ commands: unknown }>('SELECT test_commands AS commands FROM projects WHERE slug = $1', [project])
  ).rows[0]?.commands;
  const raw = environment.DEV_LOG_TEST_COMMANDS?.trim();
  return (
    parseTestCommands(stored) ??
    (raw ? parseTestCommands(JSON.parse(raw)) : null) ?? [
      ['npm', 'run', 'build'],
      ['npm', 'test'],
    ]
  );
}

/** Built-in agents: the tester runs build and tests (and records a test run), all other roles use the local model. */
export const runBuiltinAgent: BuiltinAgent = async ({ pool, item, agent, prompt, cwd, timeoutMs, signal }) => {
  if (agent.role === 'tester') {
    const startedAt = Date.now();
    const runId = await runTestAgent(
      {
        project: item.projectSlug,
        cwd,
        commands: await testCommands(pool, item.projectSlug),
        existingProject: true,
        timeoutMs,
        signal,
        env: agentEnvironment(),
      },
      pool,
    );
    const steps = await pool.query<{ command: string; status: string; output: string }>(
      'SELECT command, status, output FROM test_run_steps WHERE run_id = $1 ORDER BY position',
      [runId],
    );
    const failed = steps.rows.some((step) => step.status !== 'passed');
    const output = steps.rows
      .map(
        (step) =>
          `$ ${step.command} → ${step.status}\n${step.status === 'passed' ? step.output.slice(-400) : step.output.slice(-3000)}`,
      )
      .join('\n\n');
    return { exitCode: failed ? 1 : 0, durationMs: Date.now() - startedAt, output: `Testlauf ${runId}\n\n${output}` };
  }
  return runOllamaAgent({ prompt, role: agent.role, cwd, timeoutMs, signal });
};

async function afterStep(pool: Pool, item: WorkItem, agent: WorkflowAgent, output: string): Promise<void> {
  if (agent.role === 'documenter' && output.trim()) {
    await saveOrderDoc(pool, {
      projectSlug: item.projectSlug,
      developmentId: item.id,
      title: item.title,
      content: output,
    });
  } else if (agent.role === 'manual_writer' && output.trim().length >= MIN_MANUAL_CHARS) {
    await upsertDoc(pool, { projectSlug: item.projectSlug, kind: 'manual', title: MANUAL_TITLE, content: output });
  } else if (agent.role === 'user_manual_writer' && output.trim().length >= MIN_MANUAL_CHARS) {
    await upsertDoc(pool, { projectSlug: item.projectSlug, kind: 'manual', title: USER_MANUAL_TITLE, content: output });
  } else if (agent.role === 'developer' && item.bugId) {
    await pool.query('UPDATE bugs SET fix_notes = $2, updated_at = NOW() WHERE id = $1', [
      item.bugId,
      output.trim().slice(-1500),
    ]);
  }
}

const RUN_TIMEOUT_HOURS = 3;
const CANCEL_POLL_MS = 1500;
const LIVE_OUTPUT_INTERVAL_MS = 1500;

export interface RunContext {
  pool: Pool;
  item: WorkItem;
  runId: string;
  options: WorkItemOptions;
  execute: CommandExecutor;
  builtin: BuiltinAgent;
  done: StepSummary[];
  bugs: KnownBug[];
  images: string[];
  fallbackCommand: string[] | null;
  projectContext: string;
}

interface StepOutcome {
  passed: boolean;
  interrupted: boolean;
}

/** Claim an order run; an existing run older than three hours is treated as abandoned. */
export async function claimRun(pool: Pool, item: WorkItem): Promise<string | null> {
  await pool.query(
    `UPDATE agent_runs SET status = '${AGENT_RUN_STATUS.failed}', completed_at = NOW()
      WHERE development_id = $1 AND status = 'running' AND started_at < NOW() - INTERVAL '${RUN_TIMEOUT_HOURS} hours'`,
    [item.id],
  );
  const claim = await pool.query<{ id: string }>(
    `INSERT INTO agent_runs (project_slug, development_id, status)
     VALUES ($1, $2, '${AGENT_RUN_STATUS.running}')
     ON CONFLICT (development_id) WHERE status = 'running' DO NOTHING
     RETURNING id`,
    [item.projectSlug, item.id],
  );
  return claim.rows[0]?.id ?? null;
}

/** Select agents in phase and position order, or only the assigned agent for a manual run. */
export function selectWorkflowAgents(agents: WorkflowAgent[], item: WorkItem): WorkflowAgent[] {
  return agents
    .filter((agent) =>
      item.agentId
        ? agent.id === item.agentId
        : !(agent.role === 'author' && item.ideationId) && !(agent.role === 'bug_reviewer' && item.risks?.trim()),
    )
    .sort(
      (left, right) =>
        PHASE_ORDER.indexOf(left.phase as never) - PHASE_ORDER.indexOf(right.phase as never) ||
        left.position - right.position,
    );
}

interface StepHooks {
  signal: AbortSignal;
  onOutput: (partial: string) => void;
  onSpawn: (pid: number) => void;
}

/** Run an agent command, the tester workflow, or the built-in local model. */
async function invokeAgent(
  ctx: RunContext,
  agent: WorkflowAgent,
  prompt: string,
  hooks: StepHooks,
): Promise<CommandResult> {
  const { pool, item, options, execute, builtin, fallbackCommand } = ctx;
  const builtinRun = (): Promise<CommandResult> =>
    builtin({ pool, item, agent, prompt, cwd: options.cwd, timeoutMs: options.timeoutMs, signal: hooks.signal });
  const command = agent.command?.length ? agent.command : agent.role === 'tester' ? null : fallbackCommand;
  if (agent.role === 'tester' && !agent.command?.length && fallbackCommand) {
    // The tester first develops tests from the developer notes, then runs the build and test commands.
    const written = await execute(
      buildInvocation(
        fallbackCommand,
        `${prompt}\n\n## Aufgabe\nSchreibe oder ergänze die Tests für diesen Auftrag anhand der Angaben des Entwicklers. Führe sie nicht aus; das übernimmt anschließend der Testlauf.`,
      ),
      options.cwd,
      { timeoutMs: options.timeoutMs, env: agentEnvironment(), onOutput: hooks.onOutput },
    ).catch((error: unknown) => ({
      exitCode: 1,
      durationMs: 0,
      output: error instanceof Error ? error.message : String(error),
    }));
    const run = await builtinRun();
    return {
      ...run,
      durationMs: run.durationMs + written.durationMs,
      output: `## Entwickelte Tests\n${redactOutput(written.output, process.env).trim().slice(-1500)}\n\n## Testlauf\n${run.output}`,
    };
  }
  if (!command) return builtinRun();
  return execute(buildInvocation(command, prompt), options.cwd, {
    timeoutMs: options.timeoutMs,
    env: agentEnvironment(),
    onOutput: hooks.onOutput,
    onSpawn: hooks.onSpawn,
  });
}

/** Execute a workflow step and persist its progress, cancellation state, and result. */
export async function runStep(
  ctx: RunContext,
  agent: WorkflowAgent,
  position: number,
  total: number,
): Promise<StepOutcome> {
  const { pool, item, runId, done } = ctx;
  console.info(`[${item.id}] ${agent.phase} › ${agent.name}`);
  const stepId = (
    await pool.query<{ id: string }>(
      `INSERT INTO agent_run_steps (run_id, position, agent_id, agent_name, phase, status)
     VALUES ($1, $2, $3, $4, $5, '${AGENT_STEP_STATUS.running}') RETURNING id`,
      [runId, position, agent.id, agent.name, agent.phase],
    )
  ).rows[0]?.id;
  const manual =
    agent.role === 'manual_writer' || agent.role === 'user_manual_writer'
      ? await readManual(
          pool,
          item.projectSlug,
          agent.role === 'manual_writer' ? MANUAL_TITLE : USER_MANUAL_TITLE,
        ).catch(() => '')
      : undefined;
  const prompt = withProjectContext(
    ctx.projectContext,
    buildPrompt(agent, item, done, { bugs: ctx.bugs, manual, images: ctx.images }),
  );

  const stepAbort = new AbortController();
  let stepPid = 0;
  let cancelled = false;
  let stopWatching = (): void => undefined;
  // A UI cancellation ends the step immediately, even if the agent does not respond.
  const cancelRequested = new Promise<CommandResult>((resolveCancel) => {
    const watcher = setInterval(() => {
      void pool
        .query<{ cancel_requested: boolean }>('SELECT cancel_requested FROM agent_run_steps WHERE id = $1', [stepId])
        .then(({ rows }) => {
          if (!rows[0]?.cancel_requested || cancelled) return;
          cancelled = true;
          stepAbort.abort();
          if (stepPid) killGroup(stepPid);
          resolveCancel({ exitCode: 130, durationMs: 0, output: 'Vom Benutzer abgebrochen.' });
        })
        .catch(() => undefined);
    }, CANCEL_POLL_MS);
    stopWatching = () => clearInterval(watcher);
  });
  let lastLiveWrite = 0;
  const hooks: StepHooks = {
    signal: stepAbort.signal,
    onOutput: (partial) => {
      if (Date.now() - lastLiveWrite < LIVE_OUTPUT_INTERVAL_MS) return;
      lastLiveWrite = Date.now();
      void pool
        .query('UPDATE agent_run_steps SET output = $2 WHERE id = $1 AND status = $3', [
          stepId,
          redactOutput(partial, process.env),
          AGENT_STEP_STATUS.running,
        ])
        .catch(() => undefined);
    },
    onSpawn: (pid) => {
      stepPid = pid;
      void pool
        .query('UPDATE agent_run_steps SET pid = $2, pid_started_at = NOW() WHERE id = $1', [stepId, pid])
        .catch(() => undefined);
    },
  };
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
  const work = invokeAgent(ctx, agent, prompt, hooks).catch((error: unknown): CommandResult => ({
    exitCode: 1,
    durationMs: 0,
    output: error instanceof Error ? error.message : String(error),
  }));
  const result = await Promise.race([work, cancelRequested]);
  stopWatching();
  await progress.stop();

  const output = redactOutput(result.output, process.env);
  if (isShuttingDown()) {
    await pool.query(
      `UPDATE agent_run_steps SET status = '${AGENT_STEP_STATUS.failed}', exit_code = $2, duration_ms = $3, output = $4 WHERE id = $1`,
      [stepId, result.exitCode, result.durationMs, `${output}\nUnterbrochen: Der Worker wurde beendet.`],
    );
    return { passed: false, interrupted: true };
  }
  const passed = result.exitCode === 0 && !cancelled;
  await pool.query(
    `UPDATE agent_run_steps SET status = $2, exit_code = $3, duration_ms = $4, output = $5 WHERE id = $1`,
    [stepId, passed ? AGENT_STEP_STATUS.passed : AGENT_STEP_STATUS.failed, result.exitCode, result.durationMs, output],
  );
  done.push({
    agentName: agent.name,
    phase: agent.phase,
    status: passed ? AGENT_STEP_STATUS.passed : AGENT_STEP_STATUS.failed,
    output,
  });
  if (!passed) {
    if (!cancelled)
      await registerFailure(pool, item, agent.name, output).catch((error) =>
        console.error('Bug report failed:', error),
      );
  } else {
    await afterStep(pool, item, agent, output).catch((error) => console.error('Post-step handling failed:', error));
  }
  return { passed, interrupted: false };
}

/** Settle the order status and trigger follow-up actions such as commits or bugfix retries. */
export async function settleItem(ctx: RunContext, passed: boolean, interrupted: boolean): Promise<void> {
  const { pool, item, options, execute } = ctx;
  if (interrupted) {
    // Return interrupted orders to planned while retaining their assignment so they can resume after restart.
    await pool.query(
      `UPDATE development_items SET status = '${DEVELOPMENT_STATUS.planned}', updated_at = NOW() WHERE id = $1`,
      [item.id],
    );
    return;
  }
  if (item.agentId) {
    // A one-agent play restores the previous status; a blocked order resumes normally after success.
    await pool.query(
      `UPDATE development_items SET agent_id = NULL, return_status = NULL, updated_at = NOW(),
              status = CASE WHEN NOT $2 THEN '${DEVELOPMENT_STATUS.blocked}' WHEN return_status IS NULL OR return_status = '${DEVELOPMENT_STATUS.blocked}' THEN '${DEVELOPMENT_STATUS.planned}' ELSE return_status END
        WHERE id = $1`,
      [item.id, passed],
    );
    return;
  }
  await pool.query(
    `UPDATE development_items SET status = $2, agent_id = NULL, return_status = NULL, updated_at = NOW() WHERE id = $1`,
    [item.id, passed ? DEVELOPMENT_STATUS.done : DEVELOPMENT_STATUS.blocked],
  );
  if (!passed) return;
  if (item.sprintId) {
    const sprint = await pool
      .query<{ name: string }>('SELECT name FROM sprints WHERE id = $1', [item.sprintId])
      .catch(() => null);
    if (sprint?.rows[0]) await commitTaskToGit(options.cwd, item, sprint.rows[0].name, execute);
  }
  if (item.bugId) await resumeBlockedByBug(pool, item.bugId).catch(() => undefined);
}
