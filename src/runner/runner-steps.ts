import { logged } from '../core/log.js';
import { handoffTarget, parseHandoffs } from '../core/workflow-phases.js';
import { manualTodo, setActionTodo } from './action-todo.js';
import { withProjectContext } from '../core/project-context.js';
import { sendPush } from '../core/push.js';
import { AGENT_STEP_STATUS } from '../core/status.js';
import { isTransientFailure, registerFailure, ruleRefusal, usageLimitReset } from './autofix.js';
import { startProgress } from '../agent/chat-progress.js';
import { folderAvailable, hadOutage, missingFolderMessage } from '../core/folder-guard.js';
import { isShuttingDown, killGroup } from '../core/shutdown.js';
import { type CommandExecutor, type CommandResult, redactOutput } from '../core/command.js';
import { readManual } from '../api/docs.js';
import {
  changedFilesSection,
  commitAgentStep,
  conflictPrompt,
  type OrderBranch,
  unresolvedConflicts,
} from './git-sync.js';
import { parseCoverage, saveCoverage, stripCoverage } from './coverage.js';
import { measureCoverage, mergeCoverage } from './measured-coverage.js';
import { parseReview } from './review.js';
import {
  acceptanceProblems,
  manualChecks,
  parseAcceptance,
  saveAcceptance,
  stripAcceptance,
  waiveUnmeasuredCoverage,
} from './acceptance.js';
import type { BudgetState } from './budget.js';
import { buildPrompt } from './runner-prompts.js';
import type { WorkflowAgent } from './runner-types.js';
import { testerPlan } from './order-tests.js';
import { budgetGate, logEvent, orderChangedFiles, orderFilePaths, type RunContext } from './runner-context.js';
import {
  type AgentResult,
  findResumableSession,
  invokeAgent,
  routeStep,
  type StepHooks,
  stepModel,
} from './runner-agent.js';
import { TRANSIENT_RETRY_DELAY_MS } from './runner-runs.js';
import { afterStep, MANUAL_TITLE, USER_MANUAL_TITLE } from './runner-settle.js';

export { budgetGate, type RunContext } from './runner-context.js';
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
const CANCEL_POLL_MS = 1500;
const LIVE_OUTPUT_INTERVAL_MS = 1500;

interface StepOutcome {
  passed: boolean;
  interrupted: boolean;
  /** Gescheitert, aber noch im selben Lauf vom Entwickler nachbesserbar (kein Bug-Bericht angelegt). */
  correctable?: boolean;
  /** Budget vor dem neuen Versuch erreicht: der Lauf hält an wie vor einem Schritt (kein Bug-Bericht). */
  budget?: BudgetState;
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

/**
 * Nur ein Fehler des Agents selbst (Modell bzw. Dienst nicht erreichbar, überlastet, Zeitlimit) ist vorübergehend.
 * Rote Projekttests oder die visuelle Prüfung werden nie wiederholt, auch wenn ihre Ausgabe z. B. ECONNREFUSED enthält.
 */
export function shouldRetry(result: AgentResult): boolean {
  return result.exitCode !== 0 && !result.fromTests && isTransientFailure(result.output);
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

/** Konfliktabschnitt am Anfang des Prompts, solange der Auftrags-Branch offene Merge-Konflikte hat; sonst leer. */
export function conflictSection(branch: OrderBranch | null | undefined): string {
  return branch?.conflicts?.length ? `${conflictPrompt(branch)}\n\n` : '';
}

/**
 * Nach einem Schritt, der Konflikte lösen sollte: Dateien, die noch Marker enthalten. Scheitert die Prüfung selbst,
 * gelten die Konflikte als offen (nie stillschweigend bestanden).
 */
export async function remainingConflicts(cwd: string, execute: CommandExecutor): Promise<string[]> {
  return unresolvedConflicts(cwd, execute).catch((error: unknown) => [
    `(Prüfung fehlgeschlagen: ${error instanceof Error ? error.message : String(error)})`,
  ]);
}

/** Befehle für die eigene Abdeckungsmessung: dieselben wie im Tester-Schritt (nie der volle Lauf fürs Live schalten). */
async function coverageCommands(ctx: RunContext): Promise<string[][]> {
  const plan = await testerPlan(ctx.pool, ctx.item.projectSlug, ctx.options.cwd, await orderFilePaths(ctx));
  return plan.commands.filter((entry) => !entry.skipped).map((entry) => entry.command);
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
  const attempt = (): Promise<AgentResult> =>
    invokeAgent(ctx, agent, prompt, hooks, routed).catch((error: unknown): AgentResult => ({
      exitCode: 1,
      durationMs: 0,
      output: error instanceof Error ? error.message : String(error),
    }));
  // Der Abbruch meldet sich sofort, Git-Schritte (Commit, checkout base) dürfen aber erst laufen, wenn der Agent wirklich
  // beendet ist – sonst schreiben restliche Werkzeuge weiter und landen auf dem Basis-Branch. Das Signal erreicht
  // Modell, Werkzeuge und Prozessgruppen, das Warten endet also. Tokens und Kosten des abgebrochenen Laufs bleiben.
  const raceAttempt = async (): Promise<AgentResult> => {
    const running = attempt();
    const first = await Promise.race([running, cancelRequested]);
    if (!cancelled) return first;
    await logEvent(pool, stepId, 'Abbruch – warte, bis der Agent beendet ist');
    const ended = await running;
    return { ...first, durationMs: ended.durationMs, tokens: ended.tokens, costUsd: ended.costUsd };
  };
  let result: AgentResult = await raceAttempt();
  let budgetStop: BudgetState | null = null;
  // Vorübergehender Fehler des Agents (Modell kurz weg, überlastet, Zeitlimit): einmal nach kurzer Pause wiederholen –
  // aber nur, wenn das Budget den zweiten Versuch noch erlaubt.
  if (!cancelled && !isShuttingDown() && shouldRetry(result)) {
    budgetStop = await budgetGate(ctx).catch(logged('runner-steps', null));
    if (budgetStop) {
      await logEvent(pool, stepId, 'Vorübergehender Fehler – kein neuer Versuch, das Budget ist erreicht');
    } else {
      const delay = options.transientRetryDelayMs ?? TRANSIENT_RETRY_DELAY_MS;
      await logEvent(pool, stepId, `Vorübergehender Fehler – neuer Versuch in ${Math.round(delay / 1000)} s`);
      live.update?.(`${agent.name}: vorübergehender Fehler, neuer Versuch …`);
      const first = result;
      const paused = await Promise.race([
        new Promise<null>((resolveDelay) => setTimeout(() => resolveDelay(null), delay)),
        cancelRequested,
      ]);
      if (paused === null && !cancelled && !isShuttingDown()) {
        const second = await raceAttempt();
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
    await markInterrupted(pool, stepId, result, `${output}\n${reason}`);
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
    await markInterrupted(pool, stepId, result, `${output}\n${reason}`);
    return { passed: false, interrupted: true };
  }
  // Abnahme durch den Tester: jedes Akzeptanzkriterium und jeder DoD-Punkt muss erfüllt sein.
  let accepted = true;
  if (agent.role === 'tester' && ctx.definitionOfDone && !stepOptions.observer) {
    const criteria = ctx.criteria ?? [];
    const reportedAcceptance = parseAcceptance(output, criteria.length, ctx.definitionOfDone.length);
    // Fehlt nur die eigene Abdeckungsmessung des Testers, ist das kein Abnahmegrund: AIdeation misst danach selbst.
    const waiver = reportedAcceptance ? waiveUnmeasuredCoverage(reportedAcceptance, criteria.length) : null;
    const acceptance = waiver?.result ?? null;
    if (waiver?.waived.length) {
      await logEvent(
        pool,
        stepId,
        `Abnahme: DoD ${waiver.waived.join(', ')} trotz fehlender Abdeckungsmessung des Testers erfüllt (AIdeation misst selbst)`,
      );
    }
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
  const unresolved = conflicts && !cancelled ? await remainingConflicts(options.cwd, execute) : [];
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
  const refusedSetup: string[] = [];
  const measured =
    agent.role === 'tester' && !cancelled
      ? await measureCoverage(options.cwd, await coverageCommands(ctx), execute, (message) =>
          refusedSetup.push(message),
        ).catch(logged('runner-steps', []))
      : [];
  // Abgelehnte Befehle stehen im Schritt selbst (Ausgabe und Verlauf), nicht nur im Worker-Log.
  for (const message of refusedSetup) {
    await logEvent(pool, stepId, message);
    output += `\n\n${message}`;
  }
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
  // Budget erreicht statt neuem Versuch: kein Fehler im Code, der Lauf hält an (Kostenbremse wie vor einem Schritt).
  if (budgetStop) {
    await commitStep();
    return { passed: false, interrupted: false, correctable: false, budget: budgetStop };
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
