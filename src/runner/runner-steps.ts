import { decryptSecret } from '../core/secrets.js';
import { logged } from '../core/log.js';
import { handoffTarget, ORDER_PHASES, parseHandoffs } from '../core/workflow-phases.js';
import { manualTodo, setActionTodo } from './action-todo.js';
import type { Pool } from 'pg';
import type { KnownBug } from '../api/bugs.js';
import { withProjectContext } from '../core/project-context.js';
import { sendPush } from '../core/push.js';
import { AGENT_RUN_STATUS, AGENT_STEP_STATUS, DEVELOPMENT_STATUS } from '../core/status.js';
import { isTransientFailure, registerFailure, resumeBlockedByBug, ruleRefusal, usageLimitReset } from './autofix.js';
import { startProgress } from '../agent/chat-progress.js';
import { folderAvailable, hadOutage, missingFolderMessage } from '../core/folder-guard.js';
import { isShuttingDown, killGroup } from '../core/shutdown.js';
import { type CommandExecutor, type CommandResult, redactOutput } from '../core/command.js';
import { readManual, saveOrderDoc, upsertDoc } from '../api/docs.js';
import {
  changedFiles,
  type ChangedFile,
  changedFilesSection,
  commitAgentStep,
  commitTaskToGit,
  conflictPrompt,
  finishOrderBranch,
  type OrderBranch,
  unresolvedConflicts,
} from './git-sync.js';
import { executeAgentCommand, resumeFailed } from '../agent/claude-stream.js';
import { parseCoverage, saveCoverage, stripCoverage } from './coverage.js';
import { measureCoverage, mergeCoverage } from './measured-coverage.js';
import { parseReview } from './review.js';
import {
  holdForReview,
  isMergeConflict,
  loadReviewMode,
  needsApproval,
  retryAfterConflict,
  type ReviewMode,
} from './review-gate.js';
import { acceptanceProblems, manualChecks, parseAcceptance, saveAcceptance, stripAcceptance } from './acceptance.js';
import {
  FILES_CREATE,
  FILES_EDIT,
  loadProjectPermissions,
  normalizeCommands,
  roleDefaultCommands,
  withAgentPermissions,
} from '../agent/tool-permissions.js';
import { resolveModel, runOllamaAgent } from '../agent/ollama-agent.js';
import { describeCommand, loadRouting, type ProjectRouting, routable, routeModel } from '../agent/model-routing.js';
import { type BudgetState, checkBudget } from './budget.js';
import { runTestAgent } from './test-agent.js';
import { agentEnvironment, buildInvocation, buildPrompt, PHASE_ORDER } from './runner-prompts.js';
import type { BuiltinAgent, StepSummary, WorkItem, WorkflowAgent, WorkItemOptions } from './runner-types.js';
import { planSummary, SKIPPED_NOTE, testerPlan } from './order-tests.js';
import { runVisualStep, VISUAL_CATEGORIES } from './visual-check.js';

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
  model,
  changedFiles: changed,
}) => {
  if (agent.role === 'tester') {
    const startedAt = Date.now();
    // Nur die Tests zu den geänderten Dateien (Testbefehle je Auftrag); der volle Lauf bleibt dem Live schalten.
    const plan = await testerPlan(pool, item.projectSlug, cwd, changed);
    const runId = await runTestAgent(
      {
        project: item.projectSlug,
        cwd,
        commands: plan.commands.map((entry) => entry.command),
        skipped: plan.commands.map((entry) => entry.skipped),
        existingProject: true,
        timeoutMs,
        signal,
        env: agentEnvironment(cwd),
      },
      pool,
    );
    const steps = await pool.query<{ command: string; status: string; output: string }>(
      'SELECT command, status, output FROM test_run_steps WHERE run_id = $1 ORDER BY position',
      [runId],
    );
    const failed = steps.rows.some((step) => step.status !== 'passed');
    const output = steps.rows
      .map((step) =>
        step.output === SKIPPED_NOTE
          ? `$ ${step.command} → ${SKIPPED_NOTE}`
          : `$ ${step.command} → ${step.status}\n${step.status === 'passed' ? step.output.slice(-400) : step.output.slice(-3000)}`,
      )
      .join('\n\n');
    const summary = planSummary(plan);
    return {
      exitCode: failed ? 1 : 0,
      durationMs: Date.now() - startedAt,
      output: `Testlauf ${runId}\n\n${summary ? `${summary}\n\n` : ''}${output}`,
    };
  }
  const stored = (
    await pool.query<{ url: string | null }>('SELECT database_url AS url FROM projects WHERE slug = $1', [
      item.projectSlug,
    ])
  ).rows[0]?.url;
  // Without the key the agent runs without database access instead of failing the whole step.
  let databaseUrl: string | undefined;
  try {
    databaseUrl = stored ? decryptSecret(stored) : undefined;
  } catch (error) {
    logged(`database-url:${item.projectSlug}`)(error);
  }
  // Dieselben Dateirechte und Ordner wie bei der Claude-CLI, geprüft vom selben Wächter.
  const commands = normalizeCommands(
    agent.allowedCommands ?? roleDefaultCommands(agent.role, await loadProjectPermissions(pool, item.projectSlug)),
  );
  const files = {
    create: commands.includes(FILES_CREATE),
    edit: commands.includes(FILES_EDIT),
    scopes: agent.fileScope ?? [],
  };
  return runOllamaAgent({
    prompt,
    role: agent.role,
    cwd,
    timeoutMs,
    signal,
    databaseUrl,
    onProgress,
    files,
    commands,
    model,
  });
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
/** Rollen, die nur dokumentieren: ihr Scheitern ist kein Fehler im Code. */
/** Pause vor dem Wiederholen nach einem vorübergehenden Fehler. */
const TRANSIENT_RETRY_DELAY_MS = 30_000;

export const DOC_ROLES = new Set(['documenter', 'manual_writer', 'user_manual_writer']);
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
  /** Agents des Auftrags in Workflow-Reihenfolge (für Nachrichten an „den nächsten“ Agent). */
  ordered?: WorkflowAgent[];
  /** Nachrichten zwischen Agents (@@NACHRICHT), je Empfänger. */
  messages?: { toId: string; from: string; text: string }[];
  /** Ergebnis von „Vor dem Sprint“ für alle Aufträge des Sprints. */
  sprintNotes?: string | null;
  /** Höchster Budgetanteil (Prozent) aus der letzten Prüfung vor dem Schritt – für den Sparmodus im Routing. */
  budgetPercent?: number;
  /** Routing-Regeln und Stufen-Modelle des Projekts (einmal je Lauf geladen). */
  routing?: ProjectRouting | null;
  /** Zuletzt ermittelte geänderte Dateien des Auftrags (für den Abschnitt „Geänderte Dateien“). */
  changedFiles?: string[];
  /** Grund, warum der Lauf angehalten wurde (z. B. Budget), für die Push-Nachricht. */
  stopReason?: string | null;
}

/** Vom Routing gewähltes Modell eines Schritts: Ollama-Modell oder CLI-Befehl samt greifender Regel. */
export interface RoutedModel {
  model?: string;
  command?: string[];
  rule: string | null;
}

/**
 * Budget-Prüfpunkt vor jedem Agent-Schritt (Tag, Sprint, Auftrag): liefert den erreichten Zeitraum oder null. Ein
 * bereits laufender Schritt wird nie abgebrochen; das Limit kann daher um höchstens einen Schritt überschritten werden.
 */
export async function budgetGate(ctx: RunContext): Promise<BudgetState | null> {
  const check = await checkBudget(ctx.pool, ctx.item.projectSlug, {
    itemId: ctx.item.id,
    sprintId: ctx.item.sprintId ?? null,
  });
  ctx.budgetPercent = check.percent;
  return check.exceeded;
}

/** Modell-Routing: Stufe nach den Regeln des Projekts; ohne konfiguriertes Modell der Stufe bleibt die Wahl je Rolle. */
export async function routeStep(ctx: RunContext, agent: WorkflowAgent): Promise<RoutedModel> {
  if (!routable(agent.role)) return { rule: null };
  if (ctx.routing === undefined) ctx.routing = await loadRouting(ctx.pool, ctx.item.projectSlug).catch(() => null);
  if (!ctx.routing) return { rule: null };
  const decision = routeModel(ctx.routing.rules, {
    category: ctx.item.category ?? null,
    effortHours: ctx.item.effortHours ?? null,
    retryCount: ctx.item.retryCount ?? 0,
    budgetPercent: ctx.budgetPercent ?? 0,
  });
  const { local, strong } = ctx.routing.models;
  if (decision.tier === 'local' && local) return { model: local, rule: decision.rule };
  if (decision.tier === 'strong' && strong) return { command: strong, rule: decision.rule };
  return { rule: null };
}

/** CLI-Befehl eines Schritts: vom Routing, eigener Befehl des Agents oder Standardbefehl; null = eingebautes Modell. */
function configuredCommand(ctx: RunContext, agent: WorkflowAgent, routed: RoutedModel): string[] | null {
  if (routed.model) return null;
  if (routed.command) return routed.command;
  return agent.command?.length ? agent.command : agent.role === 'tester' ? null : ctx.fallbackCommand;
}

/** Anzeige des verwendeten Modells, z. B. „qwen3.5:9b“ oder „claude (opus)“. */
export function stepModel(ctx: RunContext, agent: WorkflowAgent, routed: RoutedModel): string {
  if (routed.model) return routed.model;
  const command = configuredCommand(ctx, agent, routed);
  if (command) return describeCommand(command);
  if (agent.role === 'tester')
    return ctx.fallbackCommand ? `${describeCommand(ctx.fallbackCommand)} + Testlauf` : 'Testlauf';
  return resolveModel(agent.role);
}

interface StepOutcome {
  passed: boolean;
  interrupted: boolean;
  /** Gescheitert, aber noch im selben Lauf vom Entwickler nachbesserbar (kein Bug-Bericht angelegt). */
  correctable?: boolean;
}

export interface StepOptions {
  /** Zeile in agent_run_steps; weicht bei einer Nachbesserung von der Agent-Position ab. */
  stepPosition?: number;
  /** Tester/Reviewer dürfen den Auftrag einmal pro Lauf zur Nachbesserung zurückgeben, statt einen Bug auszulösen. */
  canCorrect?: boolean;
  /**
   * „Bei abgelehnt“ / „Bei abgeschlossen“: läuft nach dem Ergebnis des Auftrags und ändert es nicht (kein Bug, keine
   * Abnahme); `outcome` beschreibt das Ergebnis für den Agent.
   */
  observer?: { outcome: string };
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

/**
 * Select agents in phase and position order, or only the assigned agent for a manual run. Die visuelle Prüfung
 * entfällt bei Aufträgen, die weder Frontend noch Fullstack sind.
 */
export function selectWorkflowAgents(agents: WorkflowAgent[], item: WorkItem): WorkflowAgent[] {
  return agents
    .filter((agent) => (ORDER_PHASES as readonly string[]).includes(agent.phase))
    .filter((agent) =>
      item.agentId
        ? agent.id === item.agentId
        : !(agent.role === 'author' && item.ideationId) &&
          !(agent.role === 'bug_reviewer' && item.risks?.trim()) &&
          !(agent.role === 'visual_tester' && !VISUAL_CATEGORIES.has(item.category ?? '')),
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
  onSession?: (sessionId: string) => void;
  /** Frühere Claude-Sitzung desselben Einsatzes, die fortgesetzt wird. */
  resume?: ResumableSession | null;
}

export interface ResumableSession {
  sessionId: string;
  /** Der frühere Schritt war fertig (Nachbesserung) statt abgebrochen bzw. gescheitert. */
  passed: boolean;
}

/** Wie lange eine frühere Sitzung fortgesetzt wird; danach ist ein frischer Start meist besser. */
const RESUME_WINDOW = '24 hours';

/**
 * Letzte Claude-Sitzung desselben Einsatzes (Workflow-Schritt bzw. Agent) bei diesem Auftrag – aus einem
 * abgebrochenen Lauf, einem früheren Versuch oder der Runde vor einer Nachbesserung im selben Lauf.
 */
export async function findResumableSession(
  pool: Pool,
  itemId: string,
  agent: Pick<WorkflowAgent, 'id' | 'stepId'>,
  currentStepId: string | undefined,
): Promise<ResumableSession | null> {
  const row = (
    await pool.query<{ sessionId: string; status: string }>(
      `SELECT s.session_id AS "sessionId", s.status
         FROM agent_run_steps s JOIN agent_runs r ON r.id = s.run_id
        WHERE r.development_id = $1 AND s.id IS DISTINCT FROM $2::bigint AND s.session_id IS NOT NULL
          AND COALESCE(s.workflow_step_id::text, s.agent_id::text) = $3
          AND s.session_at > NOW() - INTERVAL '${RESUME_WINDOW}'
        ORDER BY s.session_at DESC LIMIT 1`,
      [itemId, currentStepId ?? null, agent.stepId ?? agent.id],
    )
  ).rows[0];
  return row?.sessionId ? { sessionId: row.sessionId, passed: row.status === AGENT_STEP_STATUS.passed } : null;
}

/** Erste Nachricht in der fortgesetzten Sitzung: weitermachen statt neu beginnen, dann der aktuelle Auftrag. */
export function resumePrompt(prompt: string, resume: ResumableSession): string {
  const why = resume.passed
    ? 'Du hast diesen Auftrag schon bearbeitet; jetzt gibt es Rückmeldungen, die du nachbessern sollst.'
    : 'Dein letzter Lauf zu diesem Auftrag wurde unterbrochen oder abgebrochen.';
  return `## Fortsetzung deiner früheren Sitzung
${why} Du kennst den Verlauf dieser Sitzung; dein bisheriger Stand liegt im Arbeitsordner (auch noch nicht committete Änderungen). Prüfe kurz mit \`git status\` und \`git diff\`, was schon erledigt ist, und mach dort weiter – nicht von vorne beginnen. Es folgt der aktuelle Auftrag mit allen neuen Angaben; er hat Vorrang vor früheren Nachrichten.

${prompt}`;
}

/** Vom Auftrag geänderte Dateien (nur mit Auftrags-Branch; sonst undefined = unbekannt). */
async function orderChangedFiles(ctx: RunContext): Promise<ChangedFile[] | undefined> {
  if (!ctx.branch) return undefined;
  return (
    (await changedFiles(ctx.options.cwd, ctx.branch.base, ctx.execute).catch(logged('runner-steps', null))) ?? undefined
  );
}

async function orderFilePaths(ctx: RunContext): Promise<string[] | undefined> {
  return (await orderChangedFiles(ctx))?.map((file) => file.path);
}

/** Befehle für die eigene Abdeckungsmessung: dieselben wie im Tester-Schritt (nie der volle Lauf fürs Live schalten). */
async function coverageCommands(ctx: RunContext): Promise<string[][]> {
  const plan = await testerPlan(ctx.pool, ctx.item.projectSlug, ctx.options.cwd, await orderFilePaths(ctx));
  return plan.commands.filter((entry) => !entry.skipped).map((entry) => entry.command);
}

/** Run an agent command, the tester workflow, or the built-in local model. */
async function invokeAgent(
  ctx: RunContext,
  agent: WorkflowAgent,
  prompt: string,
  hooks: StepHooks,
  routed: RoutedModel = { rule: null },
): Promise<CommandResult> {
  const { pool, item, options, execute, builtin, fallbackCommand } = ctx;
  const builtinRun = async (): Promise<CommandResult> =>
    builtin({
      pool,
      item,
      agent,
      prompt,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      signal: hooks.signal,
      onProgress: hooks.onAction,
      ...(routed.model ? { model: routed.model } : {}),
      ...(agent.role === 'tester' ? { changedFiles: await orderFilePaths(ctx) } : {}),
    });
  const configured = configuredCommand(ctx, agent, routed);
  const permissions = await loadProjectPermissions(pool, item.projectSlug);
  // Visuelle Prüfung: Screenshots, Pixel-Vergleich und Browser-Prüfungen; der Befehl des Agents dient nur dem KI-Urteil.
  if (agent.role === 'visual_tester') {
    return runVisualStep({
      pool,
      item,
      cwd: options.cwd,
      criteria: ctx.criteria ?? [],
      signal: hooks.signal,
      onProgress: hooks.onAction,
      judgeCommand:
        configured &&
        withAgentPermissions(configured, agent.role, permissions, agent.allowedCommands ?? null, agent.fileScope),
      execute,
    });
  }
  const command =
    configured &&
    withAgentPermissions(configured, agent.role, permissions, agent.allowedCommands ?? null, agent.fileScope);
  if (agent.role === 'tester' && !agent.command?.length && fallbackCommand) {
    // The tester first develops tests from the developer notes, then runs the build and test commands.
    const written = await executeAgentCommand(
      execute,
      buildInvocation(
        // Auch das Schreiben der Tests läuft mit den Rechten und dem Wächter des Testers.
        withAgentPermissions(fallbackCommand, agent.role, permissions, agent.allowedCommands ?? null, agent.fileScope),
        `${prompt}\n\n## Aufgabe\nSchreibe oder ergänze die Tests für diesen Auftrag anhand der Angaben des Entwicklers. Führe sie nicht aus; das übernimmt anschließend der Testlauf.`,
      ),
      options.cwd,
      {
        timeoutMs: options.timeoutMs,
        env: agentEnvironment(options.cwd),
        onOutput: hooks.onOutput,
        // Damit ein Abbruch aus der Oberfläche auch diesen Agenten samt Kindprozessen beendet.
        onSpawn: hooks.onSpawn,
        onAction: hooks.onAction,
      },
    ).catch((error: unknown): CommandResult => ({
      exitCode: 1,
      durationMs: 0,
      output: error instanceof Error ? error.message : String(error),
    }));
    if (hooks.signal.aborted) return written;
    const run = await builtinRun();
    // Tokens und Kosten des Testschreibens zählen fürs Budget mit (zusätzlich zu denen des Testlaufs).
    return {
      ...run,
      durationMs: run.durationMs + written.durationMs,
      tokens: (written.tokens ?? 0) + (run.tokens ?? 0),
      costUsd: (written.costUsd ?? 0) + (run.costUsd ?? 0),
      output: `## Entwickelte Tests\n${redactOutput(written.output, process.env).trim().slice(-1500)}\n\n## Testlauf\n${run.output}`,
    };
  }
  if (!command) return builtinRun();
  const run = (resume: ResumableSession | null | undefined): Promise<CommandResult> =>
    executeAgentCommand(
      execute,
      buildInvocation(command, resume ? resumePrompt(prompt, resume) : prompt),
      options.cwd,
      {
        timeoutMs: options.timeoutMs,
        env: agentEnvironment(options.cwd),
        onOutput: hooks.onOutput,
        onSpawn: hooks.onSpawn,
        onAction: hooks.onAction,
        onSession: hooks.onSession,
        resumeSession: resume?.sessionId,
      },
    );
  let result = await run(hooks.resume);
  // Sitzung nicht mehr vorhanden (z. B. anderer Ordner): frisch mit dem vollständigen Auftrag starten.
  if (hooks.resume && result.exitCode !== 0 && !hooks.signal.aborted && resumeFailed(result.output)) {
    hooks.onAction('Frühere Sitzung nicht mehr vorhanden – startet neu');
    result = await run(null);
  }
  // Ein Tester mit eigenem CLI prüft selbst; danach laufen die hinterlegten Projekttests zusätzlich als
  // gespeicherter Testlauf – objektiv, sichtbar unter „Testläufe“ und in der Erfolgsquote des Dashboards.
  if (agent.role === 'tester' && result.exitCode === 0 && !hooks.signal?.aborted) {
    const run = await builtinRun();
    return {
      exitCode: run.exitCode,
      durationMs: result.durationMs + run.durationMs,
      // Tokens und Kosten des CLI-Laufs gehören zum Schritt und zählen fürs Budget.
      tokens: (result.tokens ?? 0) + (run.tokens ?? 0),
      costUsd: (result.costUsd ?? 0) + (run.costUsd ?? 0),
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
    .catch(logged('runner-steps'));
}

/** Execute a workflow step and persist its progress, cancellation state, and result. */
export async function runStep(
  ctx: RunContext,
  agent: WorkflowAgent,
  position: number,
  total: number,
  stepOptions: StepOptions = {},
): Promise<StepOutcome> {
  const { pool, item, runId, done, options, execute } = ctx;
  console.info(`[${item.id}] ${agent.phase} › ${agent.name}`);
  const routed = await routeStep(ctx, agent);
  const model = stepModel(ctx, agent, routed);
  const stepId = (
    await pool.query<{ id: string }>(
      `INSERT INTO agent_run_steps (run_id, position, agent_id, agent_name, phase, status, workflow_step_id, model, routing_rule)
     VALUES ($1, $2, $3, $4, $5, '${AGENT_STEP_STATUS.running}', $6, $7, $8) RETURNING id`,
      [
        runId,
        stepOptions.stepPosition ?? position,
        agent.id,
        agent.name,
        agent.phase,
        agent.stepId ?? null,
        model,
        routed.rule,
      ],
    )
  ).rows[0]?.id;
  await logEvent(pool, stepId, 'Schritt gestartet');
  // Stand vor dem ersten Schritt dieses Laufs, damit erkennbar ist, welcher Agent Dateien geändert hat.
  if (ctx.branch && ctx.changedFiles === undefined) ctx.changedFiles = await orderFilePaths(ctx);
  await logEvent(pool, stepId, routed.rule ? `Modell: ${model} (Regel: ${routed.rule})` : `Modell: ${model}`);
  const manual =
    agent.role === 'manual_writer' || agent.role === 'user_manual_writer'
      ? await readManual(
          pool,
          item.projectSlug,
          agent.role === 'manual_writer' ? MANUAL_TITLE : USER_MANUAL_TITLE,
        ).catch(() => '')
      : undefined;
  // Offene Merge-Konflikte des Auftrags-Branchs löst der erste Agent danach (der Entwickler), vor seiner Aufgabe.
  const conflicts = ctx.branch?.conflicts?.length ? ctx.branch : null;
  const prompt = withProjectContext(
    ctx.projectContext,
    (conflicts ? `${conflictPrompt(conflicts)}\n\n` : '') +
      buildPrompt(agent, item, done, {
        bugs: ctx.bugs,
        manual,
        images: ctx.images,
        baseBranch: ctx.branch?.base,
        criteria: ctx.criteria,
        definitionOfDone: ctx.definitionOfDone,
        messages: (ctx.messages ?? []).filter((message) => message.toId === (agent.stepId ?? agent.id)),
        sprintNotes: ctx.sprintNotes,
        outcome: stepOptions.observer?.outcome,
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
        .catch(logged('runner-steps'));
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
        .catch(logged('runner-steps'));
    },
    onAction: (message) => {
      void logEvent(pool, stepId, message);
      live.update?.(message);
    },
    onSpawn: (pid) => {
      stepPid = pid;
      void pool
        .query('UPDATE agent_run_steps SET pid = $2, pid_started_at = NOW() WHERE id = $1', [stepId, pid])
        .catch(logged('runner-steps'));
    },
    onSession: (sessionId) => {
      void pool
        .query('UPDATE agent_run_steps SET session_id = $2, session_at = NOW() WHERE id = $1', [stepId, sessionId])
        .catch(logged('runner-steps'));
    },
    resume: await findResumableSession(pool, item.id, agent, stepId).catch(logged('runner-steps', null)),
  };
  if (hooks.resume) {
    await logEvent(
      pool,
      stepId,
      hooks.resume.passed ? 'Setzt frühere Sitzung fort (Nachbesserung)' : 'Setzt abgebrochene Sitzung fort',
    );
  }
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
  const stepStartedAt = Date.now();
  // Nur ein Ordner, der beim Start da war, kann „weggefallen“ sein (sonst ist es ein Konfigurationsfehler).
  const folderAtStart = folderAvailable(ctx.options.cwd);
  const attempt = (): Promise<CommandResult> =>
    invokeAgent(ctx, agent, prompt, hooks, routed).catch((error: unknown): CommandResult => ({
      exitCode: 1,
      durationMs: 0,
      output: error instanceof Error ? error.message : String(error),
    }));
  let result = await Promise.race([attempt(), cancelRequested]);
  // Vorübergehender Fehler (Modell kurz weg, überlastet, Zeitlimit): einmal nach kurzer Pause wiederholen.
  if (result.exitCode !== 0 && !cancelled && !isShuttingDown() && isTransientFailure(result.output)) {
    const delay = options.transientRetryDelayMs ?? TRANSIENT_RETRY_DELAY_MS;
    await logEvent(pool, stepId, `Vorübergehender Fehler – neuer Versuch in ${Math.round(delay / 1000)} s`);
    live.update?.(`${agent.name}: vorübergehender Fehler, neuer Versuch …`);
    const first = result;
    const paused = await Promise.race([
      new Promise<null>((resolveDelay) => setTimeout(() => resolveDelay(null), delay)),
      cancelRequested,
    ]);
    if (paused === null && !cancelled && !isShuttingDown()) {
      const second = await Promise.race([attempt(), cancelRequested]);
      result = {
        ...second,
        durationMs: first.durationMs + second.durationMs,
        tokens: (first.tokens ?? 0) + (second.tokens ?? 0),
        costUsd: (first.costUsd ?? 0) + (second.costUsd ?? 0),
        output: `## Erster Versuch (vorübergehender Fehler)\n${first.output.slice(-1500)}\n\n## Zweiter Versuch\n${second.output}`,
      };
    } else if (paused) {
      result = paused;
    }
  }
  stopWatching();
  await progress.stop();

  let output = redactOutput(result.output, process.env);
  // Nutzungslimit des Agent-Kontos: kein Fehler im Auftrag, kein Bug, keine Wiederholung in Minuten. Der Auftrag bleibt
  // geplant und startet erst nach dem Reset wieder (retry_after); bisherige Schritte gelten wie bei einer Unterbrechung.
  const limitReset = result.exitCode !== 0 && !cancelled ? usageLimitReset(output) : null;
  if (limitReset) {
    const until = limitReset.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
    const reason = `Unterbrochen: Nutzungslimit des Agent-Kontos erreicht – der Auftrag startet ab ${until} Uhr wieder.`;
    await pool.query(
      `UPDATE agent_run_steps SET status = '${AGENT_STEP_STATUS.failed}', exit_code = $2, duration_ms = $3, output = $4 WHERE id = $1`,
      [stepId, result.exitCode, result.durationMs, `${output}\n${reason}`],
    );
    await pool
      .query(`UPDATE development_items SET retry_after = $2, failure = $3 WHERE id = $1`, [item.id, limitReset, reason])
      .catch(logged('runner-steps'));
    await logEvent(pool, stepId, reason);
    console.info(`[${item.id}] ${reason}`);
    return { passed: false, interrupted: true };
  }
  // Worker beendet oder Projektordner zwischendurch weg (externes Laufwerk getrennt): kein Fehler im Auftrag, der Lauf
  // wird erneut eingeplant – ohne Bug-Bericht und Problemanalyse.
  const folderLost = result.exitCode !== 0 && folderAtStart && hadOutage(ctx.options.cwd, stepStartedAt);
  if (isShuttingDown() || folderLost) {
    const reason = folderLost
      ? `Unterbrochen: ${missingFolderMessage(ctx.options.cwd)} Der Auftrag wird erneut eingeplant.`
      : 'Unterbrochen: Der Worker wurde beendet.';
    await pool.query(
      `UPDATE agent_run_steps SET status = '${AGENT_STEP_STATUS.failed}', exit_code = $2, duration_ms = $3, output = $4 WHERE id = $1`,
      [stepId, result.exitCode, result.durationMs, `${output}\n${reason}`],
    );
    return { passed: false, interrupted: true };
  }
  // Abnahme durch den Tester: jedes Akzeptanzkriterium und jeder DoD-Punkt muss erfüllt sein.
  let accepted = true;
  if (agent.role === 'tester' && ctx.definitionOfDone && !stepOptions.observer) {
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
      await setActionTodo(pool, item.id, manualTodo(manual)).catch(logged('runner-steps'));
      if (manual.length) {
        output += `\n\n## Von dir zu prüfen\n${manual.map((line) => `- ${line}`).join('\n')}`;
        await logEvent(pool, stepId, `Abnahme: ${manual.length} Punkt(e) nur manuell prüfbar`);
        await sendPush(
          pool,
          {
            title: `👤 Bitte selbst prüfen · ${item.projectSlug}`,
            body: `${item.title}\n${manual.join('\n')}`,
            url: `#development/${item.id}?project=${encodeURIComponent(item.projectSlug)}`,
            tag: `manual-${item.id}`,
          },
          { project: item.projectSlug },
        );
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
  // Sollte der Agent Konflikte lösen und sind noch Marker übrig, gilt der Schritt als nicht bestanden.
  const unresolved = conflicts && !cancelled ? await unresolvedConflicts(options.cwd, execute).catch(() => []) : [];
  if (unresolved.length) {
    output += `\n\nMerge-Konflikte nicht gelöst: ${unresolved.join(', ')}`;
    await logEvent(pool, stepId, `Merge-Konflikte offen: ${unresolved.join(', ')}`);
  } else if (conflicts && ctx.branch) {
    ctx.branch.conflicts = [];
    await logEvent(pool, stepId, 'Merge-Konflikte gelöst');
  }
  const passed =
    result.exitCode === 0 && !cancelled && review === true && accepted && !refusedByRule && !unresolved.length;
  // Der Tester meldet die Testabdeckung als @@COVERAGE-Block; gespeichert wird sie auch bei roten Tests.
  const reported = agent.role === 'tester' ? parseCoverage(output) : null;
  // Zusätzlich misst AIdeation selbst, wo der Node-Test-Runner läuft – unabhängig von den Rechten des Testers.
  const measured =
    agent.role === 'tester' && !cancelled
      ? await measureCoverage(options.cwd, await coverageCommands(ctx), execute).catch(logged('runner-steps', []))
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
  // Nachrichten an andere Agents (@@NACHRICHT): Empfänger bestimmen und für deren Anweisung merken.
  const handoffs = parseHandoffs(output).flatMap((handoff) => {
    const ordered = ctx.ordered ?? [];
    const target = handoffTarget(handoff, agent, ordered, ordered.indexOf(agent));
    return target ? [{ to: target.name, toId: target.stepId ?? target.id, text: handoff.text }] : [];
  });
  for (const handoff of handoffs) {
    ctx.messages = [...(ctx.messages ?? []), { toId: handoff.toId, from: agent.name, text: handoff.text }];
    await logEvent(pool, stepId, `Nachricht an ${handoff.to}: ${handoff.text.slice(0, 120)}`);
  }
  // Geänderte Dateien des Auftrags: am Auftrag speichern und in der Ausgabe jedes Agents auflisten, der Dateien
  // geändert hat (der Entwickler immer, auch bei Nachbesserungen).
  if (ctx.branch && !cancelled) {
    const files = await orderChangedFiles(ctx);
    if (files) {
      const paths = files.map((file) => file.path);
      const before = ctx.changedFiles ?? [];
      ctx.changedFiles = paths;
      await pool
        .query('UPDATE development_items SET changed_files = $2 WHERE id = $1', [item.id, paths])
        .catch(logged('runner-steps'));
      if (agent.role === 'developer' || paths.join('\n') !== before.join('\n')) {
        output = `${output.trimEnd()}\n\n${changedFilesSection(files)}`;
        await logEvent(pool, stepId, `Geänderte Dateien: ${paths.length}`);
      }
    }
  }
  await pool.query(
    `UPDATE agent_run_steps SET status = $2, exit_code = $3, duration_ms = $4, output = $5, tokens = $6, cost_usd = $7,
            handoffs = $8::jsonb WHERE id = $1`,
    [
      stepId,
      passed ? AGENT_STEP_STATUS.passed : AGENT_STEP_STATUS.failed,
      result.exitCode,
      result.durationMs,
      output,
      result.tokens ?? 0,
      result.costUsd ?? 0,
      JSON.stringify(handoffs.map(({ to, text }) => ({ to, text }))),
    ],
  );
  done.push({
    agentName: agent.name,
    phase: agent.phase,
    status: passed ? AGENT_STEP_STATUS.passed : AGENT_STEP_STATUS.failed,
    output,
  });
  const commitStep = async (): Promise<void> => {
    if (!ctx.branch || cancelled) return;
    const commit = await commitAgentStep(
      options.cwd,
      item,
      agent.name,
      ctx.sprintName ?? null,
      passed,
      execute,
      ctx.branch.branch,
    );
    if (commit) await logEvent(pool, stepId, `Commit ${commit} (Änderungen von ${agent.name})`);
  };
  // „Bei abgelehnt“ / „Bei abgeschlossen“ ändern das Ergebnis des Auftrags nicht.
  if (stepOptions.observer) {
    await commitStep();
    return { passed, interrupted: false };
  }
  // Rote Tests oder eine Ablehnung im Review gehen zuerst einmal direkt zurück an den Entwickler.
  const correctable = !passed && !cancelled && !refusedByRule && stepOptions.canCorrect === true;
  if (correctable) {
    await logEvent(pool, stepId, 'Zurück an den Entwickler zur Nachbesserung (im selben Lauf)');
  } else if (!passed) {
    // Dokumentations-Agents sollen keinen Bug-Bericht für fertigen Code erzeugen. Tester und Reviewer schon:
    // rote Tests oder eine Ablehnung im Review führen zu Bug, Problemanalyse und (bei Code-Fehler) Behebung.
    if (!cancelled && !DOC_ROLES.has(agent.role))
      await registerFailure(pool, item, agent.name, output).catch((error) =>
        console.error('Bug report failed:', error),
      );
  } else {
    await afterStep(pool, item, agent, output).catch((error) => console.error('Post-step handling failed:', error));
  }
  await commitStep();
  return { passed, interrupted: false, correctable };
}

/** Push-Nachricht aufs Handy, wenn ein Auftrag fertig ist oder hängen bleibt. */
async function notifySettled(pool: Pool, item: WorkItem, succeeded: boolean, problem: string | null): Promise<void> {
  await sendPush(
    pool,
    {
      title: succeeded ? `✓ Auftrag erledigt · ${item.projectSlug}` : `⚠ Auftrag blockiert · ${item.projectSlug}`,
      body: succeeded ? item.title : `${item.title}\n${problem ?? 'Ein Agent ist gescheitert – Details im Auftrag.'}`,
      url: `#development/${item.id}?project=${encodeURIComponent(item.projectSlug)}`,
      tag: `order-${item.id}`,
    },
    { project: item.projectSlug },
  );
}

/** Settle the order status and trigger follow-up actions such as commits or bugfix retries. */
export async function settleItem(ctx: RunContext, passed: boolean, interrupted: boolean): Promise<void> {
  const { pool, item, options, execute } = ctx;
  if (interrupted) {
    // Arbeitsordner freigeben: Zwischenstand als WIP-Commit auf dem Auftrags-Branch sichern und zur Basis zurück.
    // Sonst bliebe der Ordner (oft stundenlang, z. B. beim Nutzungslimit) auf diesem Branch stehen, und jeder andere
    // Auftrag scheiterte an „fremden Änderungen“. Der nächste Lauf setzt den Branch samt WIP fort (enterOrderBranch).
    if (ctx.branch) {
      const saved = await finishOrderBranch(options.cwd, item, ctx.branch, ctx.sprintName ?? '', false, execute).catch(
        (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
      );
      console.info(`[${item.id}] Unterbrochen – ${saved.message}`);
    }
    // Return interrupted orders to planned while retaining their assignment so they can resume after restart.
    await pool.query(
      `UPDATE development_items SET status = '${DEVELOPMENT_STATUS.planned}', updated_at = NOW() WHERE id = $1`,
      [item.id],
    );
    return;
  }
  // Auftrags-Branch abschließen: bei Erfolg in den Sprint-/Basis-Branch mergen, sonst Zwischenstand sichern.
  let mergeProblem: string | null = null;
  let commit: string | null = null;
  if (ctx.branch) {
    // Review-Freigabe (Projekteinstellung): nur ganze Abläufe, nicht das Ausführen eines einzelnen Agents.
    const review =
      passed && !item.agentId ? await loadReviewMode(pool, item.projectSlug).catch((): ReviewMode => 'off') : 'off';
    const hold = review === 'off' ? undefined : (files: string[]) => needsApproval(review, files);
    const result = await finishOrderBranch(options.cwd, item, ctx.branch, ctx.sprintName ?? '', passed, execute, hold);
    console.info(`[${item.id}] ${result.message}`);
    if (result.held) {
      await holdForReview(pool, item, ctx.branch);
      return;
    }
    if (passed && !result.merged) mergeProblem = result.message;
    commit = result.commit;
  } else if (passed && ctx.sprintName) {
    commit = await commitTaskToGit(options.cwd, item, ctx.sprintName, execute);
  }
  if (commit) {
    // Verweis für die GitHub-Rückmeldung (Issue schließen mit Commit). Nur ein Zusatz: Fehlt er, nennt der
    // Kommentar keinen Commit – der Abschluss des Auftrags darf daran nicht scheitern.
    await pool
      .query(`UPDATE development_items SET git_commit = $2 WHERE id = $1`, [item.id, commit])
      .catch((error: unknown) => console.warn(`[${item.id}] Commit-Verweis nicht gespeichert: ${String(error)}`));
  }
  // Merge-Konflikt mit der Basis: automatisch neu einplanen; der nächste Lauf zieht die Basis nach und der Entwickler
  // löst die Konflikte (höchstens zweimal, danach „Aktion notwendig“ wie bisher).
  if (mergeProblem && isMergeConflict(mergeProblem) && !item.agentId) {
    if (await retryAfterConflict(pool, item, mergeProblem).catch(logged('runner-steps', false))) return;
  }
  const succeeded = passed && !mergeProblem;
  if (mergeProblem) {
    await pool
      .query(`UPDATE development_items SET failure = $2 WHERE id = $1`, [item.id, mergeProblem])
      .catch(logged('runner-steps'));
  }
  if (item.agentId) {
    // A one-agent play restores the previous status; a blocked order resumes normally after success.
    await pool.query(
      `UPDATE development_items SET agent_id = NULL, return_status = NULL, updated_at = NOW(),
              status = CASE WHEN status IN ('${DEVELOPMENT_STATUS.rejected}', '${DEVELOPMENT_STATUS.backlog}') THEN status WHEN NOT $2 THEN '${DEVELOPMENT_STATUS.blocked}' WHEN return_status IS NULL OR return_status = '${DEVELOPMENT_STATUS.blocked}' THEN '${DEVELOPMENT_STATUS.planned}' ELSE return_status END
        WHERE id = $1`,
      [item.id, succeeded],
    );
    await notifySettled(pool, item, succeeded, mergeProblem ?? ctx.stopReason ?? null);
    return;
  }
  // „Abgelehnt“ (Projektregel, gesetzt in registerFailure) bleibt stehen statt „Blockiert“. „Backlog“ ebenso: der
  // Sprint wurde währenddessen abgebrochen (cancelSprint), der Auftrag bleibt draußen und wartet unter „Aktionen“.
  await pool.query(
    `UPDATE development_items SET agent_id = NULL, return_status = NULL, updated_at = NOW(),
            status = CASE WHEN status IN ('${DEVELOPMENT_STATUS.rejected}', '${DEVELOPMENT_STATUS.backlog}') THEN status ELSE $2 END WHERE id = $1`,
    [item.id, succeeded ? DEVELOPMENT_STATUS.done : DEVELOPMENT_STATUS.blocked],
  );
  await notifySettled(pool, item, succeeded, mergeProblem ?? ctx.stopReason ?? null);
  if (!succeeded) return;
  if (item.bugId) await resumeBlockedByBug(pool, item.bugId).catch(logged('runner-steps'));
}
