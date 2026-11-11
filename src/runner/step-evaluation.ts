/**
 * Bewertung der Ausgabe eines Workflow-Schritts: Abnahme des Testers, Freigabe des Reviewers, Projektregeln,
 * Merge-Konflikte, Testabdeckung, Nachrichten an andere Agents und geänderte Dateien. Jede Prüfung ergänzt die
 * Ausgabe des Schritts, damit das Ergebnis in der Oberfläche nachvollziehbar ist.
 */
import { logged } from '../core/log.js';
import { handoffTarget, parseHandoffs } from '../core/workflow-phases.js';
import { manualTodo, setActionTodo } from './action-todo.js';
import { sendPush } from '../core/push.js';
import { EVIDENCE_ROLES } from './runner-prompts.js';
import { ruleRefusal } from './autofix.js';
import type { CommandExecutor } from '../core/command.js';
import { changedFilesSection, conflictPrompt, type OrderBranch, unresolvedConflicts } from './git-sync.js';
import { parseCoverage, saveCoverage, stripCoverage } from './coverage.js';
import { measureCoverage, mergeCoverage } from './measured-coverage.js';
import { parseReview } from './review.js';
import {
  acceptanceProblems,
  manualChecks,
  parseAcceptance,
  parseEvidence,
  saveAcceptance,
  saveEvidence,
  stripAcceptance,
  stripEvidence,
  waiveUnmeasuredCoverage,
} from './acceptance.js';
import type { WorkflowAgent } from './runner-types.js';
import { testerPlan } from './order-tests.js';
import { logEvent, orderChangedFiles, orderFilePaths, type RunContext } from './runner-context.js';
import type { AgentResult } from './runner-agent.js';
import { gateExecutor } from './test-sandbox.js';

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

/** Was eine Prüfung an der Ausgabe ändert und ob der Schritt daran scheitert. */
export interface Verdict {
  output: string;
  passed: boolean;
}

/**
 * Abnahme durch den Tester: jedes Akzeptanzkriterium und jeder DoD-Punkt muss erfüllt sein. Nur Tester mit eigenem
 * CLI-Befehl melden die Abnahme; der eingebaute Tester führt nur Build und Tests aus. Manuell prüfbare Punkte landen
 * als „Aktion notwendig“ am Auftrag und als Push beim Menschen.
 */
export async function judgeAcceptance(
  ctx: RunContext,
  agent: WorkflowAgent,
  stepId: string,
  result: AgentResult,
  output: string,
  coverageSaved: boolean,
): Promise<Verdict> {
  const { pool, item } = ctx;
  if (!ctx.definitionOfDone) return { output, passed: true };
  const criteria = ctx.criteria ?? [];
  const reportedAcceptance = parseAcceptance(output, criteria.length, ctx.definitionOfDone.length);
  // Fehlt nur die eigene Abdeckungsmessung des Testers, ist das kein Abnahmegrund: AIdeation misst danach selbst.
  const waiver = reportedAcceptance
    ? waiveUnmeasuredCoverage(reportedAcceptance, criteria.length, coverageSaved)
    : null;
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
  if (!agent.command?.length || result.exitCode !== 0) return { output, passed: true };
  const problems = acceptance
    ? acceptanceProblems(acceptance, criteria, ctx.definitionOfDone)
    : ['Kein Abnahme-Ergebnis (@@ACCEPTANCE) gemeldet – bitte jedes Kriterium einzeln prüfen.'];
  let stripped = stripAcceptance(output);
  if (problems.length) {
    stripped += `\n\n## Abnahme nicht bestanden\n${problems.map((line) => `- ${line}`).join('\n')}`;
    await logEvent(pool, stepId, `Abnahme: ${problems.length} Punkt(e) offen oder nicht erfüllt`);
  } else {
    await logEvent(pool, stepId, 'Abnahme: alle Kriterien und DoD-Punkte erfüllt');
  }
  const manual = manualChecks(acceptance, criteria);
  await setActionTodo(pool, item.id, manualTodo(manual)).catch(logged('step-evaluation'));
  if (manual.length) {
    stripped += `\n\n## Von dir zu prüfen\n${manual.map((line) => `- ${line}`).join('\n')}`;
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
  return { output: stripped, passed: problems.length === 0 };
}

/** Der Reviewer muss ausdrücklich freigeben; ohne eindeutiges Ergebnis gilt der Schritt als nicht bestanden. */
export async function judgeReview(
  pool: RunContext['pool'],
  agent: WorkflowAgent,
  stepId: string,
  result: AgentResult,
  output: string,
): Promise<boolean> {
  if (agent.role !== 'reviewer') return true;
  const review = parseReview(output);
  if (review !== true && result.exitCode === 0) {
    await logEvent(pool, stepId, review === false ? 'Review: Änderungen nötig' : 'Review ohne eindeutiges Ergebnis');
  } else {
    await logEvent(pool, stepId, 'Review: freigegeben');
  }
  return review === true;
}

/** Lehnt ein Agent wegen einer Projektregel ab (@@REGEL), endet der Ablauf: „Aktion notwendig“ statt „Erledigt“. */
export async function refusedByRule(pool: RunContext['pool'], stepId: string, output: string): Promise<boolean> {
  const refused = ruleRefusal(output) !== null;
  if (refused) await logEvent(pool, stepId, 'Abgelehnt wegen Projektregel');
  return refused;
}

/**
 * Sollte der Agent Merge-Konflikte lösen: Sind noch Marker übrig, gilt der Schritt als nicht bestanden; sonst gelten die
 * Konflikte des Auftrags-Branchs als gelöst.
 */
export async function judgeConflicts(
  ctx: RunContext,
  stepId: string,
  hadConflicts: boolean,
  cancelled: boolean,
  output: string,
): Promise<Verdict> {
  if (!hadConflicts) return { output, passed: true };
  const unresolved = cancelled ? [] : await remainingConflicts(ctx.options.cwd, ctx.execute);
  if (unresolved.length) {
    await logEvent(ctx.pool, stepId, `Merge-Konflikte offen: ${unresolved.join(', ')}`);
    return { output: `${output}\n\nMerge-Konflikte nicht gelöst: ${unresolved.join(', ')}`, passed: false };
  }
  if (ctx.branch) ctx.branch.conflicts = [];
  await logEvent(ctx.pool, stepId, 'Merge-Konflikte gelöst');
  return { output, passed: true };
}

/** Befehle für die eigene Abdeckungsmessung: dieselben wie im Tester-Schritt (nie der volle Lauf fürs Live schalten). */
async function coverageCommands(ctx: RunContext): Promise<string[][]> {
  const plan = await testerPlan(ctx.pool, ctx.item.projectSlug, ctx.options.cwd, await orderFilePaths(ctx));
  return plan.commands.filter((entry) => !entry.skipped).map((entry) => entry.command);
}

/**
 * Testabdeckung nach einem Tester-Schritt: der gemeldete @@COVERAGE-Block (auch bei roten Tests) und die eigene Messung
 * von AIdeation, wo der Node-Test-Runner läuft – unabhängig von den Rechten des Testers. Abgelehnte Befehle stehen im
 * Schritt selbst, nicht nur im Worker-Log.
 */
export async function recordCoverage(
  ctx: RunContext,
  agent: WorkflowAgent,
  stepId: string,
  cancelled: boolean,
  output: string,
): Promise<{ output: string; saved: boolean }> {
  if (agent.role !== 'tester') return { output, saved: false };
  const { pool, item, options, execute } = ctx;
  const reported = parseCoverage(output);
  for (const message of reported.errors) {
    await logEvent(pool, stepId, `Testabdeckung des Testers verworfen: ${message}`);
  }
  const refusedSetup: string[] = [];
  const measured = cancelled
    ? []
    : await measureCoverage(
        options.cwd,
        await coverageCommands(ctx),
        // Projektcode: in der Sandbox im Testcontainer, nicht auf dem Host.
        await gateExecutor(pool, item.projectSlug, options.cwd, execute, ctx.runId),
        (message) => refusedSetup.push(message),
      ).catch(logged('step-evaluation', []));
  let extended = output;
  for (const message of refusedSetup) {
    await logEvent(pool, stepId, message);
    extended += `\n\n${message}`;
  }
  const merged = mergeCoverage(reported.report, measured);
  for (const message of merged.errors) await logEvent(pool, stepId, message);
  let saved = false;
  if (merged.report) {
    const failure = await saveCoverage(pool, item.projectSlug, item.id, merged.report).then(
      () => null,
      (error: unknown) => {
        console.error('Coverage could not be saved:', error);
        return error instanceof Error ? error.message : String(error);
      },
    );
    saved = failure === null;
    await logEvent(
      pool,
      stepId,
      saved
        ? `Testabdeckung gespeichert (${merged.report.areas.map((area) => area.area).join(', ')})`
        : `Testabdeckung nicht gespeichert: ${failure}`.slice(0, 1000),
    );
  } else {
    await logEvent(pool, stepId, 'Testabdeckung nicht gespeichert: kein gültiger Bericht und keine Messung');
  }
  const errors = [...reported.errors, ...merged.errors];
  if (errors.length) extended += `\n\nTestabdeckung des Testers verworfen: ${errors.join(' ')}`;
  return { output: stripCoverage(extended), saved };
}

/** Speichert gemeldete offene Testnachweise und entfernt deren Marker aus der sichtbaren Ausgabe. */
export async function recordEvidence(
  ctx: RunContext,
  agent: WorkflowAgent,
  stepId: string,
  cancelled: boolean,
  output: string,
): Promise<string> {
  if (cancelled || !EVIDENCE_ROLES.has(agent.role)) return output;
  const evidence = parseEvidence(output);
  const stripped = stripEvidence(output);
  if (!evidence.length) return stripped;
  const created = await saveEvidence(ctx.pool, ctx.item.id, evidence, agent.name).catch(logged('step-evaluation', 0));
  await logEvent(ctx.pool, stepId, `Testnachweise: ${evidence.length} gemeldet, ${created} neu`);
  return stripped;
}

export interface Handoff {
  to: string;
  toId: string;
  text: string;
}

/** Nachrichten an andere Agents (@@NACHRICHT): Empfänger bestimmen und für deren Anweisung am Kontext merken. */
export async function collectHandoffs(
  ctx: RunContext,
  agent: WorkflowAgent,
  stepId: string,
  output: string,
): Promise<Handoff[]> {
  const ordered = ctx.ordered ?? [];
  const handoffs = parseHandoffs(output).flatMap((handoff) => {
    const target = handoffTarget(handoff, agent, ordered, ordered.indexOf(agent));
    return target ? [{ to: target.name, toId: target.stepId ?? target.id, text: handoff.text }] : [];
  });
  for (const handoff of handoffs) {
    ctx.messages = [...(ctx.messages ?? []), { toId: handoff.toId, from: agent.name, text: handoff.text }];
    await logEvent(ctx.pool, stepId, `Nachricht an ${handoff.to}: ${handoff.text.slice(0, 120)}`);
  }
  return handoffs;
}

/**
 * Geänderte Dateien des Auftrags: am Auftrag speichern und in der Ausgabe jedes Agents auflisten, der Dateien geändert
 * hat (der Entwickler immer, auch bei Nachbesserungen).
 */
export async function appendChangedFiles(
  ctx: RunContext,
  agent: WorkflowAgent,
  stepId: string,
  cancelled: boolean,
  output: string,
): Promise<string> {
  if (!ctx.branch || cancelled) return output;
  const files = await orderChangedFiles(ctx);
  if (!files) return output;
  const paths = files.map((file) => file.path);
  const before = ctx.changedFiles ?? [];
  ctx.changedFiles = paths;
  await ctx.pool
    .query('UPDATE development_items SET changed_files = $2 WHERE id = $1', [ctx.item.id, paths])
    .catch(logged('step-evaluation'));
  if (agent.role !== 'developer' && paths.join('\n') === before.join('\n')) return output;
  await logEvent(ctx.pool, stepId, `Geänderte Dateien: ${paths.length}`);
  return `${output.trimEnd()}\n\n${changedFilesSection(files)}`;
}
