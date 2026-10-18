import { manualTodo, setActionTodo } from './action-todo.js';
import type { Pool } from 'pg';
import type { KnownBug } from '../api/bugs.js';
import { withProjectContext } from '../core/project-context.js';
import { sendPush } from '../core/push.js';
import { AGENT_RUN_STATUS, AGENT_STEP_STATUS, DEVELOPMENT_STATUS } from '../core/status.js';
import { registerFailure, resumeBlockedByBug, ruleRefusal } from './autofix.js';
import { startProgress } from '../agent/chat-progress.js';
import { isShuttingDown, killGroup } from '../core/shutdown.js';
import { type CommandExecutor, type CommandResult, redactOutput } from '../core/command.js';
import { readManual, saveOrderDoc, upsertDoc } from '../api/docs.js';
import { commitTaskToGit, finishOrderBranch, type OrderBranch } from './git-sync.js';
import { executeAgentCommand } from '../agent/claude-stream.js';
import { parseCoverage, saveCoverage, stripCoverage } from './coverage.js';
import { measureCoverage, mergeCoverage } from './measured-coverage.js';
import { parseReview } from './review.js';
import { acceptanceProblems, manualChecks, parseAcceptance, saveAcceptance, stripAcceptance } from './acceptance.js';
import { loadPermissionGroups, withAssistantPermissions } from '../agent/tool-permissions.js';
import { runOllamaAgent } from '../agent/ollama-agent.js';
import { runTestAgent } from './test-agent.js';
import { agentEnvironment, buildInvocation, buildPrompt, PHASE_ORDER } from './runner-prompts.js';
import type { BuiltinAgent, StepSummary, WorkItem, WorkflowAgent, WorkItemOptions } from './runner-types.js';
import { loadTestCommands } from './runner-selection.js';

const MANUAL_TITLE = 'Anwendungshandbuch';
const USER_MANUAL_TITLE = 'Benutzerhandbuch';
const MIN_MANUAL_CHARS = 200;

/** Built-in agents: the tester runs build and tests (and records a test run), all other roles use the local model. */
export const runBuiltinAgent: BuiltinAgent = async ({
  pool,
  item,
  agent,
  prompt,
  cwd,
  timeoutMs,
  signal,
  onProgress,
}) => {
  if (agent.role === 'tester') {
    const startedAt = Date.now();
    const runId = await runTestAgent(
      {
        project: item.projectSlug,
        cwd,
        commands: await loadTestCommands(pool, item.projectSlug),
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
  const databaseUrl = (
    await pool.query<{ url: string | null }>('SELECT database_url AS url FROM projects WHERE slug = $1', [
      item.projectSlug,
    ])
  ).rows[0]?.url;
  return runOllamaAgent({ prompt, role: agent.role, cwd, timeoutMs, signal, databaseUrl, onProgress });
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
  /** Eigener Git-Branch des Auftrags (null, wenn ohne Git oder kein Agent Dateien ändert). */
  branch?: OrderBranch | null;
  /** Akzeptanzkriterien aus dem Auftragstext und Definition of Done des Projekts. */
  criteria?: string[];
  definitionOfDone?: string[];
  sprintName?: string | null;
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
  onAction: (message: string) => void;
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
    builtin({
      pool,
      item,
      agent,
      prompt,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      signal: hooks.signal,
      onProgress: hooks.onAction,
    });
  const configured = agent.command?.length ? agent.command : agent.role === 'tester' ? null : fallbackCommand;
  const groups = await loadPermissionGroups(pool, item.projectSlug);
  const command = configured && withAssistantPermissions(configured, agent.role, undefined, groups);
  if (agent.role === 'tester' && !agent.command?.length && fallbackCommand) {
    // The tester first develops tests from the developer notes, then runs the build and test commands.
    const written = await executeAgentCommand(
      execute,
      buildInvocation(
        fallbackCommand,
        `${prompt}\n\n## Aufgabe\nSchreibe oder ergänze die Tests für diesen Auftrag anhand der Angaben des Entwicklers. Führe sie nicht aus; das übernimmt anschließend der Testlauf.`,
      ),
      options.cwd,
      { timeoutMs: options.timeoutMs, env: agentEnvironment(), onOutput: hooks.onOutput, onAction: hooks.onAction },
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
  const result = await executeAgentCommand(execute, buildInvocation(command, prompt), options.cwd, {
    timeoutMs: options.timeoutMs,
    env: agentEnvironment(),
    onOutput: hooks.onOutput,
    onSpawn: hooks.onSpawn,
    onAction: hooks.onAction,
  });
  // Ein Tester mit eigenem CLI prüft selbst; danach laufen die hinterlegten Projekttests zusätzlich als
  // gespeicherter Testlauf – objektiv, sichtbar unter „Testläufe“ und in der Erfolgsquote des Dashboards.
  if (
    agent.role === 'tester' &&
    result.exitCode === 0 &&
    !hooks.signal?.aborted &&
    (await loadTestCommands(pool, item.projectSlug)).length
  ) {
    const run = await builtinRun();
    return {
      exitCode: run.exitCode,
      durationMs: result.durationMs + run.durationMs,
      output: `${result.output}\n\n## Testlauf (Projekttests)\n${run.output}`,
    };
  }
  return result;
}

/** Appends a timestamped entry to the step's history (shown as "Verlauf"). */
function logEvent(pool: Pool, stepId: string | undefined, text: string): Promise<unknown> {
  return pool
    .query(`UPDATE agent_run_steps SET events = events || $2::jsonb WHERE id = $1`, [
      stepId,
      JSON.stringify([{ at: new Date().toISOString(), text: redactOutput(text, process.env) }]),
    ])
    .catch(() => undefined);
}

/** Execute a workflow step and persist its progress, cancellation state, and result. */
export async function runStep(
  ctx: RunContext,
  agent: WorkflowAgent,
  position: number,
  total: number,
): Promise<StepOutcome> {
  const { pool, item, runId, done, options, execute } = ctx;
  console.info(`[${item.id}] ${agent.phase} › ${agent.name}`);
  const stepId = (
    await pool.query<{ id: string }>(
      `INSERT INTO agent_run_steps (run_id, position, agent_id, agent_name, phase, status)
     VALUES ($1, $2, $3, $4, $5, '${AGENT_STEP_STATUS.running}') RETURNING id`,
      [runId, position, agent.id, agent.name, agent.phase],
    )
  ).rows[0]?.id;
  await logEvent(pool, stepId, 'Schritt gestartet');
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
    buildPrompt(agent, item, done, {
      bugs: ctx.bugs,
      manual,
      images: ctx.images,
      baseBranch: ctx.branch?.base,
      criteria: ctx.criteria,
      definitionOfDone: ctx.definitionOfDone,
    }),
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
  const live: { update?: (message: string) => void } = {};
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
    onAction: (message) => {
      void logEvent(pool, stepId, message);
      live.update?.(message);
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
  live.update = progress.update;
  const work = invokeAgent(ctx, agent, prompt, hooks).catch((error: unknown): CommandResult => ({
    exitCode: 1,
    durationMs: 0,
    output: error instanceof Error ? error.message : String(error),
  }));
  const result = await Promise.race([work, cancelRequested]);
  stopWatching();
  await progress.stop();

  let output = redactOutput(result.output, process.env);
  if (isShuttingDown()) {
    await pool.query(
      `UPDATE agent_run_steps SET status = '${AGENT_STEP_STATUS.failed}', exit_code = $2, duration_ms = $3, output = $4 WHERE id = $1`,
      [stepId, result.exitCode, result.durationMs, `${output}\nUnterbrochen: Der Worker wurde beendet.`],
    );
    return { passed: false, interrupted: true };
  }
  // Abnahme durch den Tester: jedes Akzeptanzkriterium und jeder DoD-Punkt muss erfüllt sein.
  let accepted = true;
  if (agent.role === 'tester' && ctx.definitionOfDone) {
    const criteria = ctx.criteria ?? [];
    const acceptance = parseAcceptance(output, criteria.length, ctx.definitionOfDone.length);
    await saveAcceptance(pool, item.id, criteria, ctx.definitionOfDone, acceptance).catch((error) =>
      console.error('Abnahme konnte nicht gespeichert werden:', error),
    );
    // Nur Tester mit eigenem CLI-Befehl melden die Abnahme; der eingebaute Tester führt nur Build und Tests aus.
    if (agent.command?.length && result.exitCode === 0) {
      const problems = acceptance
        ? acceptanceProblems(acceptance, criteria, ctx.definitionOfDone)
        : ['Kein Abnahme-Ergebnis (@@ACCEPTANCE) gemeldet – bitte jedes Kriterium einzeln prüfen.'];
      output = stripAcceptance(output);
      if (problems.length) {
        accepted = false;
        output += `\n\n## Abnahme nicht bestanden\n${problems.map((line) => `- ${line}`).join('\n')}`;
        await logEvent(pool, stepId, `Abnahme: ${problems.length} Punkt(e) offen oder nicht erfüllt`);
      } else {
        await logEvent(pool, stepId, 'Abnahme: alle Kriterien und DoD-Punkte erfüllt');
      }
      const manual = manualChecks(acceptance, criteria);
      await setActionTodo(pool, item.id, manualTodo(manual)).catch(() => undefined);
      if (manual.length) {
        output += `\n\n## Von dir zu prüfen\n${manual.map((line) => `- ${line}`).join('\n')}`;
        await logEvent(pool, stepId, `Abnahme: ${manual.length} Punkt(e) nur manuell prüfbar`);
        await sendPush(pool, {
          title: `👤 Bitte selbst prüfen · ${item.projectSlug}`,
          body: `${item.title}\n${manual.join('\n')}`,
          url: '#development',
          tag: `manual-${item.id}`,
        });
      }
    }
  }
  // Der Reviewer muss ausdrücklich freigeben; ohne eindeutiges Ergebnis gilt der Schritt als nicht bestanden.
  const review = agent.role === 'reviewer' ? parseReview(output) : true;
  if (review !== true && result.exitCode === 0) {
    await logEvent(pool, stepId, review === false ? 'Review: Änderungen nötig' : 'Review ohne eindeutiges Ergebnis');
  } else if (agent.role === 'reviewer') {
    await logEvent(pool, stepId, 'Review: freigegeben');
  }
  // Lehnt ein Agent wegen einer Projektregel ab (@@REGEL), endet der Ablauf: „Aktion notwendig“ statt „Erledigt“.
  const refusedByRule = ruleRefusal(output) !== null;
  if (refusedByRule) await logEvent(pool, stepId, 'Abgelehnt wegen Projektregel');
  const passed = result.exitCode === 0 && !cancelled && review === true && accepted && !refusedByRule;
  // Der Tester meldet die Testabdeckung als @@COVERAGE-Block; gespeichert wird sie auch bei roten Tests.
  const reported = agent.role === 'tester' ? parseCoverage(output) : null;
  // Zusätzlich misst Dev Log selbst, wo der Node-Test-Runner läuft – unabhängig von den Rechten des Testers.
  const measured =
    agent.role === 'tester' && !cancelled
      ? await measureCoverage(options.cwd, await loadTestCommands(pool, item.projectSlug), execute).catch(() => [])
      : [];
  const coverage = mergeCoverage(reported, measured);
  if (coverage) {
    await saveCoverage(pool, item.projectSlug, item.id, coverage).catch((error) =>
      console.error('Coverage could not be saved:', error),
    );
    await logEvent(pool, stepId, `Testabdeckung gespeichert (${coverage.areas.map((area) => area.area).join(', ')})`);
    output = stripCoverage(output);
  }
  await logEvent(
    pool,
    stepId,
    cancelled ? 'Abgebrochen' : passed ? 'Erfolgreich abgeschlossen' : `Fehlgeschlagen (Exit-Code ${result.exitCode})`,
  );
  await pool.query(
    `UPDATE agent_run_steps SET status = $2, exit_code = $3, duration_ms = $4, output = $5, tokens = $6, cost_usd = $7 WHERE id = $1`,
    [
      stepId,
      passed ? AGENT_STEP_STATUS.passed : AGENT_STEP_STATUS.failed,
      result.exitCode,
      result.durationMs,
      output,
      result.tokens ?? 0,
      result.costUsd ?? 0,
    ],
  );
  done.push({
    agentName: agent.name,
    phase: agent.phase,
    status: passed ? AGENT_STEP_STATUS.passed : AGENT_STEP_STATUS.failed,
    output,
  });
  if (!passed) {
    // Dokumentations-Agents nach der Umsetzung sollen keinen Bug-Bericht für fertigen Code erzeugen.
    if (!cancelled && agent.phase !== 'after_task')
      await registerFailure(pool, item, agent.name, output).catch((error) =>
        console.error('Bug report failed:', error),
      );
  } else {
    await afterStep(pool, item, agent, output).catch((error) => console.error('Post-step handling failed:', error));
  }
  return { passed, interrupted: false };
}

/** Push-Nachricht aufs Handy, wenn ein Auftrag fertig ist oder hängen bleibt. */
async function notifySettled(pool: Pool, item: WorkItem, succeeded: boolean, problem: string | null): Promise<void> {
  await sendPush(pool, {
    title: succeeded ? `✓ Auftrag erledigt · ${item.projectSlug}` : `⚠ Auftrag blockiert · ${item.projectSlug}`,
    body: succeeded ? item.title : `${item.title}\n${problem ?? 'Ein Agent ist gescheitert – Details im Auftrag.'}`,
    url: '#development',
    tag: `order-${item.id}`,
  });
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
  // Auftrags-Branch abschließen: bei Erfolg in den Sprint-/Basis-Branch mergen, sonst Zwischenstand sichern.
  let mergeProblem: string | null = null;
  if (ctx.branch) {
    const result = await finishOrderBranch(options.cwd, item, ctx.branch, ctx.sprintName ?? '', passed, execute);
    console.info(`[${item.id}] ${result.message}`);
    if (passed && !result.merged) mergeProblem = result.message;
  } else if (passed && ctx.sprintName) {
    await commitTaskToGit(options.cwd, item, ctx.sprintName, execute);
  }
  const succeeded = passed && !mergeProblem;
  if (mergeProblem) {
    await pool
      .query(`UPDATE development_items SET failure = $2 WHERE id = $1`, [item.id, mergeProblem])
      .catch(() => undefined);
  }
  if (item.agentId) {
    // A one-agent play restores the previous status; a blocked order resumes normally after success.
    await pool.query(
      `UPDATE development_items SET agent_id = NULL, return_status = NULL, updated_at = NOW(),
              status = CASE WHEN NOT $2 THEN '${DEVELOPMENT_STATUS.blocked}' WHEN return_status IS NULL OR return_status = '${DEVELOPMENT_STATUS.blocked}' THEN '${DEVELOPMENT_STATUS.planned}' ELSE return_status END
        WHERE id = $1`,
      [item.id, succeeded],
    );
    await notifySettled(pool, item, succeeded, mergeProblem);
    return;
  }
  await pool.query(
    `UPDATE development_items SET status = $2, agent_id = NULL, return_status = NULL, updated_at = NOW() WHERE id = $1`,
    [item.id, succeeded ? DEVELOPMENT_STATUS.done : DEVELOPMENT_STATUS.blocked],
  );
  await notifySettled(pool, item, succeeded, mergeProblem);
  if (!succeeded) return;
  if (item.bugId) await resumeBlockedByBug(pool, item.bugId).catch(() => undefined);
}
