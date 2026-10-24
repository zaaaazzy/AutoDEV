// Aufruf eines Agents in einem Schritt: Modellwahl, CLI-Befehl mit Rechten, eingebauter Tester bzw. lokales Modell.
import type { Pool } from 'pg';
import { decryptSecret } from '../core/secrets.js';
import { logged } from '../core/log.js';
import { AGENT_STEP_STATUS } from '../core/status.js';
import { type CommandResult, redactOutput } from '../core/command.js';
import { executeAgentCommand, resumeFailed } from '../agent/claude-stream.js';
import {
  FILES_CREATE,
  FILES_EDIT,
  loadProjectPermissions,
  normalizeCommands,
  roleDefaultCommands,
  withAgentPermissions,
} from '../agent/tool-permissions.js';
import { resolveModel, runOllamaAgent } from '../agent/ollama-agent.js';
import { describeCommand, loadRouting, routable, routeModel } from '../agent/model-routing.js';
import { calibratedHours, loadCalibration } from '../core/estimate-calibration.js';
import { runTestAgent } from './test-agent.js';
import { projectEnvironment } from './project-command.js';
import { agentEnvironment, buildInvocation } from './runner-prompts.js';
import type { BuiltinAgent, WorkflowAgent } from './runner-types.js';
import { planSummary, SKIPPED_NOTE, testerPlan } from './order-tests.js';
import { runVisualStep } from './visual-check.js';
import { orderFilePaths, type RunContext } from './runner-context.js';

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
        // Testbefehle sind Projektcode: nur das gefilterte Environment, nicht das der Agent-CLIs.
        env: projectEnvironment(cwd),
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

/** Vom Routing gewähltes Modell eines Schritts: Ollama-Modell oder CLI-Befehl samt greifender Regel. */
export interface RoutedModel {
  model?: string;
  command?: string[];
  rule: string | null;
}

/** Modell-Routing: Stufe nach den Regeln des Projekts; ohne konfiguriertes Modell der Stufe bleibt die Wahl je Rolle. */
export async function routeStep(ctx: RunContext, agent: WorkflowAgent): Promise<RoutedModel> {
  if (!routable(agent.role)) return { rule: null };
  if (ctx.routing === undefined) ctx.routing = await loadRouting(ctx.pool, ctx.item.projectSlug).catch(() => null);
  if (!ctx.routing) return { rule: null };
  // Die Regeln vergleichen Agent-Stunden: Schätzung mit dem gemessenen Faktor ihrer Herkunft umrechnen.
  const estimate = ctx.item.effortHours ?? null;
  if (ctx.routedHours === undefined)
    ctx.routedHours = await loadCalibration(ctx.pool, ctx.item.projectSlug)
      .then((calibration) => calibratedHours(estimate, ctx.item.estimateSource, calibration))
      .catch(() => estimate);
  const decision = routeModel(ctx.routing.rules, {
    category: ctx.item.category ?? null,
    effortHours: ctx.routedHours,
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

export interface StepHooks {
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

/**
 * Ergebnis eines Agent-Aufrufs. `fromTests`: Das Ergebnis (Exit-Code und Ausgabe) stammt aus den Projekttests bzw. der
 * visuellen Prüfung, nicht vom Agent selbst – dann ist ein Fehler nie ein vorübergehender Agent-Fehler.
 */
export interface AgentResult extends CommandResult {
  fromTests?: boolean;
}

/** Run an agent command, the tester workflow, or the built-in local model. */
export async function invokeAgent(
  ctx: RunContext,
  agent: WorkflowAgent,
  prompt: string,
  hooks: StepHooks,
  routed: RoutedModel = { rule: null },
): Promise<AgentResult> {
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
    const visual = await runVisualStep({
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
    return { ...visual, fromTests: true };
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
        // Auch ein Abbruch vor onSpawn (noch keine PID) beendet bzw. verhindert den Prozess.
        signal: hooks.signal,
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
      fromTests: true,
    };
  }
  // Der eingebaute Tester (ohne eigenen CLI-Befehl) liefert das Ergebnis der Projekttests.
  if (!command) return agent.role === 'tester' ? { ...(await builtinRun()), fromTests: true } : builtinRun();
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
        signal: hooks.signal,
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
      fromTests: true,
    };
  }
  return result;
}
