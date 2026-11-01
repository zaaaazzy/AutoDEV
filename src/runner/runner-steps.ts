import { logged } from '../core/log.js';
import { withProjectContext } from '../core/project-context.js';
import { AGENT_STEP_STATUS } from '../core/status.js';
import { isSandboxFailure, registerFailure, usageLimitReset } from './autofix.js';
import { noteProviderOutcome, USAGE_LIMIT_REASON } from '../core/provider-limits.js';
import { folderAvailable, hadOutage, missingFolderMessage } from '../core/folder-guard.js';
import { isShuttingDown } from '../core/shutdown.js';
import { redactOutput } from '../core/command.js';
import { readManual } from '../api/docs.js';
import { commitAgentStep } from './git-sync.js';
import { buildPrompt } from './runner-prompts.js';
import type { WorkflowAgent } from './runner-types.js';
import { logEvent, orderFilePaths, recordBudgetCheckFailure, type RunContext } from './runner-context.js';
import { type AgentResult, configuredCommand, routeStep, stepModel } from './runner-agent.js';
import { afterStep, MANUAL_TITLE, USER_MANUAL_TITLE } from './runner-settle.js';
import { type Invocation, invokeWithRetry } from './step-invocation.js';
import { probeBugfixOrder } from './counter-probe.js';
import { gateExecutor, projectSandbox } from './test-sandbox.js';
import { sandboxMode, usesSandbox } from '../core/sandbox.js';
import { UNPROVEN_FIX_MARK } from '../core/shared-types.js';
import {
  appendChangedFiles,
  collectHandoffs,
  conflictSection,
  type Handoff,
  judgeAcceptance,
  judgeConflicts,
  judgeReview,
  recordCoverage,
  recordEvidence,
  refusedByRule,
} from './step-evaluation.js';

export {
  budgetGate,
  guardedBudgetGate,
  recordBudgetCheckFailure,
  BUDGET_CHECK_RETRY_MS,
  type RunContext,
} from './runner-context.js';
export {
  findResumableSession,
  type ResumableSession,
  resumePrompt,
  type RoutedModel,
  routeStep,
  runBuiltinAgent,
  stepModel,
} from './runner-agent.js';
export { claimRun, selectWorkflowAgents } from './runner-runs.js';
export { settleItem } from './runner-settle.js';

/** Rollen, die nur dokumentieren: ihr Scheitern ist kein Fehler im Code. */
export const DOC_ROLES = new Set(['documenter', 'manual_writer', 'user_manual_writer']);

interface StepOutcome {
  passed: boolean;
  interrupted: boolean;
  /** Gescheitert, aber noch im selben Lauf vom Entwickler nachbesserbar (kein Bug-Bericht angelegt). */
  correctable?: boolean;
  /** Budget vor dem neuen Versuch erreicht: der Lauf hält an wie vor einem Schritt (kein Bug-Bericht). */
  budget?: Invocation['budgetStop'];
  /** Vom Benutzer abgebrochen („Abbrechen“, Sprint-Abbruch): kein weiterer Agent des Auftrags, auch nicht „Bei abgelehnt“. */
  cancelled?: boolean;
}

const INTERRUPTED: StepOutcome = { passed: false, interrupted: true };

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

/**
 * Unterbrochener Schritt (Worker beendet, Ordner weg, Nutzungslimit): bleibt „failed“, trägt aber das Kennzeichen
 * `interrupted`, damit der nächste Lauf beim selben Agent fortsetzt. Tokens und Kosten des Versuchs bleiben erhalten.
 */
async function markInterrupted(
  pool: RunContext['pool'],
  stepId: string,
  result: AgentResult,
  output: string,
): Promise<void> {
  await pool.query(
    `UPDATE agent_run_steps SET status = '${AGENT_STEP_STATUS.failed}', exit_code = $2, duration_ms = $3, output = $4,
            tokens = $5, cost_usd = $6, interrupted = TRUE WHERE id = $1`,
    [stepId, result.exitCode, result.durationMs, output, result.tokens ?? 0, result.costUsd ?? 0],
  );
}

/** Pausen wegen eines defekten Arbeitscontainers je Auftrag (innerhalb eines Tages), bevor er blockiert. */
export const SANDBOX_PAUSES = 2;
export const SANDBOX_PAUSE_MS = 60 * 60_000;
const SANDBOX_PAUSE_MARK = 'Arbeitscontainer bzw. Sandbox defekt, kein Fehler im Auftrag';

/** Wie oft der Auftrag in den letzten 24 Stunden schon wegen eines defekten Arbeitscontainers pausiert hat. */
async function sandboxPauses(pool: RunContext['pool'], itemId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM agent_run_steps s JOIN agent_runs r ON r.id = s.run_id
      WHERE r.development_id = $1 AND s.interrupted AND r.started_at > NOW() - INTERVAL '24 hours'
        AND strpos(s.output, $2) > 0`,
    [itemId, SANDBOX_PAUSE_MARK],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** Führt einen Workflow-Schritt aus und speichert Fortschritt, Abbruch und Ergebnis. */
export async function runStep(
  ctx: RunContext,
  agent: WorkflowAgent,
  position: number,
  total: number,
  stepOptions: StepOptions = {},
): Promise<StepOutcome> {
  const { pool, item, runId } = ctx;
  console.info(`[${item.id}] ${agent.phase} › ${agent.name}`);
  const routed = await routeStep(ctx, agent);
  const model = stepModel(ctx, agent, routed);
  // Der Workflow kann während des Laufs umgebaut werden: Gibt es den geladenen Schritt oder Agent nicht mehr, läuft der
  // Schritt ohne Verweis (NULL) zu Ende, statt am Fremdschlüssel zu scheitern und den Lauf abzubrechen.
  const stepId = (
    await pool.query<{ id: string }>(
      `INSERT INTO agent_run_steps (run_id, position, agent_id, agent_name, phase, status, workflow_step_id, model, routing_rule)
     VALUES ($1, $2, (SELECT id FROM agents WHERE id = $3::uuid), $4, $5, '${AGENT_STEP_STATUS.running}',
             (SELECT id FROM workflow_steps WHERE id = $6::uuid), $7, $8)
     RETURNING id`,
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
  // Ab hier steht der Schritt auf „läuft“: Wirft etwas vor dem Endstatus (Datenbank, Testbefehle), gilt er als
  // gescheitert. Die Aufräumroutinen erfassen nur Schritte noch laufender Läufe, der Schritt hinge sonst für immer.
  try {
    return await executeStep(ctx, agent, position, total, stepOptions, stepId, routed, model);
  } catch (error) {
    await pool
      .query(`UPDATE agent_run_steps SET status = '${AGENT_STEP_STATUS.failed}' WHERE id = $1 AND status = $2`, [
        stepId,
        AGENT_STEP_STATUS.running,
      ])
      .catch((cleanup: unknown) => console.error(`[${item.id}] Schritt-Status nicht zurückgesetzt:`, cleanup));
    throw error;
  }
}

/** Anweisung für den Agent: Projektkontext, offene Merge-Konflikte zuerst, dann die Aufgabe des Schritts. */
async function buildStepPrompt(
  ctx: RunContext,
  agent: WorkflowAgent,
  stepOptions: StepOptions,
  stepId: string,
  routed: Awaited<ReturnType<typeof routeStep>>,
  model: ReturnType<typeof stepModel>,
): Promise<{ prompt: string; hadConflicts: boolean }> {
  const { pool, item, done } = ctx;
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
    conflictSection(conflicts) +
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
  return { prompt, hadConflicts: conflicts !== null };
}

/** Der Auftrag pausiert bis `until` (retry_after); der Schritt gilt als unterbrochen, nicht als gescheitert. */
async function pauseOrder(
  ctx: RunContext,
  stepId: string,
  result: AgentResult,
  output: string,
  reason: string,
  until: Date,
): Promise<StepOutcome> {
  const { pool, item } = ctx;
  await markInterrupted(pool, stepId, result, `${output}\n${reason}`);
  await pool
    .query(`UPDATE development_items SET retry_after = $2, failure = $3 WHERE id = $1`, [item.id, until, reason])
    .catch(logged('runner-steps'));
  await logEvent(pool, stepId, reason);
  console.info(`[${item.id}] ${reason}`);
  return INTERRUPTED;
}

const clock = (date: Date): string => date.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });

/**
 * Unterbrechungen, die kein Fehler im Auftrag sind (kein Bug, keine Problemanalyse, derselbe Agent setzt später fort):
 * Nutzungslimit des Agent-Kontos, defekter Arbeitscontainer, nicht prüfbares Budget, beendeter Worker oder ein
 * zwischendurch verschwundener Projektordner. Liefert null, wenn der Schritt regulär bewertet wird.
 */
async function interruptionOutcome(
  ctx: RunContext,
  agent: WorkflowAgent,
  stepId: string,
  invocation: Invocation,
  output: string,
  folderAtStart: boolean,
): Promise<StepOutcome | null> {
  const { pool, item } = ctx;
  const { result, cancelled, budgetUnchecked, startedAt } = invocation;
  const failed = result.exitCode !== 0 && !cancelled;
  // Der Auftrag bleibt geplant und startet erst nach dem Reset wieder (retry_after).
  const limitReset = failed ? usageLimitReset(output) : null;
  if (limitReset) {
    const reason = `${USAGE_LIMIT_REASON} – der Auftrag startet ab ${clock(limitReset)} Uhr wieder.`;
    return pauseOrder(ctx, stepId, result, output, reason, limitReset);
  }
  // Das ganze Projekt pausiert (retry_after gilt projektweit), statt dass jeder Auftrag einzeln scheitert, Bugs anlegt
  // und Problemanalysen startet. Nach SANDBOX_PAUSES Pausen bleibt der Auftrag blockiert (registerFailure: „Aktion
  // notwendig“), bis ein Mensch den Container repariert hat.
  if (failed && isSandboxFailure(output)) {
    const pauses = await sandboxPauses(pool, item.id).catch(() => SANDBOX_PAUSES);
    if (pauses < SANDBOX_PAUSES) {
      const until = new Date(Date.now() + SANDBOX_PAUSE_MS);
      const reason = `Unterbrochen: ${SANDBOX_PAUSE_MARK} – das Projekt pausiert bis ${clock(until)} Uhr, dann neuer Versuch.`;
      return pauseOrder(ctx, stepId, result, output, reason, until);
    }
  }
  // Budget vor dem zweiten Versuch nicht prüfbar: unterbrochen wie vor einem Schritt – ohne Bug-Bericht und ohne
  // Nachbesserung. Tokens und Kosten des ersten Versuchs bleiben am Schritt.
  if (budgetUnchecked) {
    await markInterrupted(pool, stepId, result, `${output}\n${budgetUnchecked}`);
    await recordBudgetCheckFailure(ctx, agent, budgetUnchecked, null).catch(logged('runner-steps'));
    await logEvent(pool, stepId, budgetUnchecked);
    ctx.stopReason = budgetUnchecked;
    return INTERRUPTED;
  }
  // Worker beendet oder Projektordner zwischendurch weg (externes Laufwerk getrennt): der Lauf wird erneut eingeplant.
  const folderLost = result.exitCode !== 0 && folderAtStart && hadOutage(ctx.options.cwd, startedAt);
  if (isShuttingDown() || folderLost) {
    const reason = folderLost
      ? `Unterbrochen: ${missingFolderMessage(ctx.options.cwd)} Der Auftrag wird erneut eingeplant.`
      : 'Unterbrochen: Der Worker wurde beendet.';
    await markInterrupted(pool, stepId, result, `${output}\n${reason}`);
    return INTERRUPTED;
  }
  return null;
}

interface StepVerdict {
  output: string;
  passed: boolean;
  /** Der Agent hat wegen einer Projektregel abgelehnt (@@REGEL): keine Nachbesserung, „Aktion notwendig“. */
  refusedByRule: boolean;
}

/** Bestanden nur, wenn der Agent fehlerfrei endete und Abnahme, Review, Projektregeln und Konfliktlösung es zulassen. */
async function judgeStep(
  ctx: RunContext,
  agent: WorkflowAgent,
  stepId: string,
  stepOptions: StepOptions,
  invocation: Invocation,
  hadConflicts: boolean,
  output: string,
  coverageSaved: boolean,
): Promise<StepVerdict> {
  const { result, cancelled } = invocation;
  let passed = result.exitCode === 0 && !cancelled;
  let text = output;
  if (agent.role === 'tester' && !stepOptions.observer) {
    const acceptance = await judgeAcceptance(ctx, agent, stepId, result, text, coverageSaved);
    text = acceptance.output;
    passed = passed && acceptance.passed;
  }
  const approved = await judgeReview(ctx.pool, agent, stepId, result, text);
  const refused = await refusedByRule(ctx.pool, stepId, text);
  const conflicts = await judgeConflicts(ctx, stepId, hadConflicts, cancelled, text);
  return {
    output: conflicts.output,
    passed: passed && approved && !refused && conflicts.passed,
    refusedByRule: refused,
  };
}

/** Endstatus und Ausgabe des Schritts speichern und den Nachfolgern im Lauf bekannt machen. */
async function recordStep(
  ctx: RunContext,
  agent: WorkflowAgent,
  stepId: string,
  passed: boolean,
  result: AgentResult,
  output: string,
  handoffs: Handoff[],
): Promise<void> {
  const status = passed ? AGENT_STEP_STATUS.passed : AGENT_STEP_STATUS.failed;
  await ctx.pool.query(
    `UPDATE agent_run_steps SET status = $2, exit_code = $3, duration_ms = $4, output = $5, tokens = $6, cost_usd = $7,
            handoffs = $8::jsonb WHERE id = $1`,
    [
      stepId,
      status,
      result.exitCode,
      result.durationMs,
      output,
      result.tokens ?? 0,
      result.costUsd ?? 0,
      JSON.stringify(handoffs.map(({ to, text }) => ({ to, text }))),
    ],
  );
  ctx.done.push({ agentName: agent.name, phase: agent.phase, status, output });
}

/**
 * Was aus dem Ergebnis folgt: Beobachter („Bei abgelehnt“ / „Bei abgeschlossen“) ändern nichts; ein erreichtes Budget
 * hält den Lauf an; rote Tests oder eine Ablehnung im Review gehen zuerst einmal direkt zurück an den Entwickler, sonst
 * entsteht ein Bug-Bericht (nie bei Dokumentations-Agents). Zuletzt wird der Stand des Agents committet.
 */
async function settleOutcome(
  ctx: RunContext,
  agent: WorkflowAgent,
  stepId: string,
  stepOptions: StepOptions,
  invocation: Invocation,
  verdict: StepVerdict,
): Promise<StepOutcome> {
  const { pool, item, options, execute } = ctx;
  const { cancelled, budgetStop } = invocation;
  const { passed, output } = verdict;
  const commit = async (): Promise<void> => {
    if (!ctx.branch || cancelled) return;
    const sha = await commitAgentStep(
      options.cwd,
      item,
      agent.name,
      ctx.sprintName ?? null,
      passed,
      execute,
      ctx.branch.branch,
    );
    if (sha) await logEvent(pool, stepId, `Commit ${sha} (Änderungen von ${agent.name})`);
  };
  if (stepOptions.observer) {
    await commit();
    return { passed, interrupted: false, cancelled };
  }
  // Budget erreicht statt neuem Versuch: kein Fehler im Code, der Lauf hält an (Kostenbremse wie vor einem Schritt).
  if (budgetStop) {
    await commit();
    return { passed: false, interrupted: false, correctable: false, budget: budgetStop };
  }
  const correctable = !passed && !cancelled && !verdict.refusedByRule && stepOptions.canCorrect === true;
  if (correctable) {
    await logEvent(pool, stepId, 'Zurück an den Entwickler zur Nachbesserung (im selben Lauf)');
  } else if (!passed) {
    // Tester und Reviewer lösen Bug, Problemanalyse und (bei Code-Fehler) Behebung aus; Dokumentations-Agents nicht.
    if (!cancelled && !DOC_ROLES.has(agent.role)) {
      await registerFailure(pool, item, agent.name, output).catch((error) =>
        console.error('Bug report failed:', error),
      );
    }
  } else {
    await afterStep(pool, item, agent, output).catch((error) => console.error('Post-step handling failed:', error));
  }
  await commit();
  return { passed, interrupted: false, correctable, cancelled };
}

/** Ein Schritt von Anweisung bis Commit: Agent aufrufen, Unterbrechungen erkennen, Ergebnis bewerten und festhalten. */
async function executeStep(
  ctx: RunContext,
  agent: WorkflowAgent,
  position: number,
  total: number,
  stepOptions: StepOptions,
  stepId: string,
  routed: Awaited<ReturnType<typeof routeStep>>,
  model: ReturnType<typeof stepModel>,
): Promise<StepOutcome> {
  const { pool } = ctx;
  const { prompt, hadConflicts } = await buildStepPrompt(ctx, agent, stepOptions, stepId, routed, model);
  // Nur ein Ordner, der beim Start da war, kann „weggefallen“ sein (sonst ist es ein Konfigurationsfehler).
  const folderAtStart = folderAvailable(ctx.options.cwd);
  const invocation = await invokeWithRetry(ctx, agent, prompt, routed, stepId, position, total);
  const raw = redactOutput(invocation.result.output, process.env);
  const providerCommand =
    configuredCommand(ctx, agent, routed) ?? (agent.role === 'tester' && !routed.model ? ctx.fallbackCommand : null);
  if (!invocation.cancelled) {
    await noteProviderOutcome(pool, providerCommand, { exitCode: invocation.result.exitCode, output: raw }).catch(
      logged('runner-steps'),
    );
  }
  const interrupted = await interruptionOutcome(ctx, agent, stepId, invocation, raw, folderAtStart);
  if (interrupted) return interrupted;
  const coverage = await recordCoverage(ctx, agent, stepId, invocation.cancelled, raw);
  const evidenceOutput = await recordEvidence(ctx, agent, stepId, invocation.cancelled, coverage.output);
  let verdict = await judgeStep(
    ctx,
    agent,
    stepId,
    stepOptions,
    invocation,
    hadConflicts,
    evidenceOutput,
    coverage.saved,
  );
  let output = verdict.output;
  if (
    verdict.passed &&
    agent.role === 'tester' &&
    ctx.item.kind === 'bug' &&
    ctx.branch &&
    !stepOptions.observer &&
    !invocation.cancelled
  ) {
    let probeUnproven = false;
    try {
      const outcome = await probeBugfixOrder({
        pool,
        item: ctx.item,
        cwd: ctx.options.cwd,
        baseBranch: ctx.branch.base,
        changedFiles: (await orderFilePaths(ctx)) ?? [],
        execute: ctx.execute,
        testExecutor: (folder) =>
          gateExecutor(pool, ctx.item.projectSlug, folder, ctx.execute, `${ctx.runId}-gegenprobe`),
        linkModules: !usesSandbox(sandboxMode(await projectSandbox(pool, ctx.item.projectSlug))),
        stepStartedAt: invocation.startedAt,
      });
      const cases = outcome.check.cases ?? [];
      const count = (result: string) => cases.filter((entry) => entry.result === result).length;
      const summary =
        outcome.check.verdict === 'none'
          ? 'keine neuen Testfälle'
          : `${count('fails')} scheitern wie erwartet, ${count('passes')} bestehen, ${count('inconclusive')} nicht auswertbar`;
      const event = `Gegenprobe: ${summary}${outcome.unproven ? ` – ${UNPROVEN_FIX_MARK}` : ''}${outcome.report ? ` (${outcome.report})` : ''}`;
      output += `\n\n${outcome.section}`;
      probeUnproven = outcome.unproven;
      await logEvent(pool, stepId, event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output += `\n\n## Gegenprobe\n\nNicht gelaufen: ${message}\n`;
      await logEvent(pool, stepId, `Gegenprobe nicht gelaufen: ${message}`.slice(0, 1000));
    }
    if (probeUnproven) verdict = { ...verdict, passed: false };
  }
  await logEvent(
    pool,
    stepId,
    invocation.cancelled
      ? 'Abgebrochen'
      : verdict.passed
        ? 'Erfolgreich abgeschlossen'
        : `Fehlgeschlagen (Exit-Code ${invocation.result.exitCode})`,
  );
  const handoffs = await collectHandoffs(ctx, agent, stepId, output);
  output = await appendChangedFiles(ctx, agent, stepId, invocation.cancelled, output);
  await recordStep(ctx, agent, stepId, verdict.passed, invocation.result, output, handoffs);
  return settleOutcome(ctx, agent, stepId, stepOptions, invocation, { ...verdict, output });
}
