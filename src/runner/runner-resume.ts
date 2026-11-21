// Fortsetzen eines Auftrags über frühere Läufe hinweg und Übernahme eines unveränderten Tester-Ergebnisses.
import type { Pool } from 'pg';
import { AGENT_RUN_STATUS, AGENT_STEP_STATUS } from '../core/status.js';
import { gitHelpers } from './git-sync.js';
import { logEvent, type RunContext } from './runner-context.js';
import type { StepSummary, WorkflowAgent } from './runner-types.js';

/** Rollen, deren Ablehnung den Auftrag zurück zum Entwickler schickt. */
export const LOOP_BACK_ROLES = new Set(['tester', 'reviewer']);

interface StepRow {
  agent_id: string;
  workflow_step_id: string | null;
  agent_name: string;
  phase: string;
  status: string;
  output: string;
  interrupted?: boolean | null;
}

/** Schlüssel je Einsatz: derselbe Agent kann im Workflow mehrfach vorkommen (eigener Workflow-Schritt). */
const keyOf = (row: Pick<StepRow, 'agent_id' | 'workflow_step_id'>): string => row.workflow_step_id ?? row.agent_id;
const keyOfAgent = (agent: WorkflowAgent): string => agent.stepId ?? agent.id;

/**
 * Frühere Läufe des Auftrags, die zum laufenden Versuch gehören: vom jüngsten rückwärts bis (ausschliesslich) zum
 * letzten erfolgreichen Lauf. Läufe ohne Schritte (z. B. OrderBranchError vor dem ersten Agent) zählen nicht als
 * Neustart und werden übersprungen – bisher löschte so ein Lauf den ganzen Fortschritt (pianotrainer, 21.11.2026:
 * Entwickler und Tester liefen viermal). Ergebnis in zeitlicher Reihenfolge (älteste zuerst), je Lauf seine Schritte.
 */
async function previousRunSteps(pool: Pool, itemId: string, currentRunId: string): Promise<StepRow[][]> {
  const runs = (
    await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_runs WHERE development_id = $1 AND id <> $2 ORDER BY started_at DESC`,
      [itemId, currentRunId],
    )
  ).rows;
  const chain: StepRow[][] = [];
  for (const run of runs) {
    if (run.status === AGENT_RUN_STATUS.passed) break;
    if (run.status !== AGENT_RUN_STATUS.failed) continue;
    const rows = (
      await pool.query<StepRow>(
        `SELECT agent_id, workflow_step_id, agent_name, phase, status, output, interrupted
           FROM agent_run_steps WHERE run_id = $1 ORDER BY position`,
        [run.id],
      )
    ).rows;
    if (rows.length) chain.unshift(rows);
  }
  return chain;
}

/**
 * Jüngster Schritt je Einsatz des Ablaufs über alle Läufe der Kette hinweg. Die Zeilen eines Laufs werden der Reihe
 * nach dem nächsten passenden Einsatz zugeordnet (ein fortgesetzter Lauf beginnt mitten im Ablauf; derselbe Agent
 * kann ohne eigenen Workflow-Schritt mehrfach vorkommen). Springt eine Zeile zurück (Nachbesserung: Entwickler nach
 * dem Tester), zählt ab dort von vorn – spätere Zeilen und spätere Läufe überschreiben frühere, auch ein späterer
 * Fehlschlag setzt den Einsatz zurück. Zeilen zu Einsätzen, die es im Ablauf nicht mehr gibt (Beobachter, umgebauter
 * Workflow), bleiben aussen vor.
 */
function latestSteps(chain: StepRow[][], ordered: WorkflowAgent[]): (StepRow | undefined)[] {
  const keys = ordered.map(keyOfAgent);
  const latest: (StepRow | undefined)[] = ordered.map(() => undefined);
  for (const rows of chain) {
    let cursor = 0;
    for (const row of rows) {
      const key = keyOf(row);
      let index = keys.indexOf(key, cursor);
      if (index < 0) index = keys.indexOf(key);
      if (index < 0) continue;
      latest[index] = row;
      cursor = index + 1;
    }
  }
  return latest;
}

/**
 * Nach einem gescheiterten oder unterbrochenen Lauf laufen nur der gescheiterte Agent und die danach erneut: Vorangehende
 * Agents, die in einem der Läufe seit dem letzten erfolgreichen bestanden haben, werden übersprungen und ihre Ausgabe an
 * die folgenden Agents weitergegeben. Liefert die Position im Ablauf, bei der dieser Lauf beginnt.
 */
export async function resumePosition(
  pool: Pool,
  itemId: string,
  currentRunId: string,
  ordered: WorkflowAgent[],
  done: StepSummary[],
): Promise<number> {
  const chain = await previousRunSteps(pool, itemId, currentRunId);
  if (!chain.length) return 0;
  const steps = latestSteps(chain, ordered);
  let position = 0;
  while (position < ordered.length) {
    const step = steps[position];
    if (!step || step.status !== AGENT_STEP_STATUS.passed) break;
    done.push({ agentName: step.agent_name, phase: step.phase, status: 'passed', output: step.output });
    position += 1;
  }
  // Lehnen Tester oder Reviewer ab, beginnt der nächste Versuch wieder beim Entwickler – mit deren Rückmeldung.
  // Wurde der Schritt nur unterbrochen (Worker beendet, Ordner weg, Nutzungslimit), setzt derselbe Agent fort.
  const failed = steps[position];
  const failedAgent = ordered[position];
  if (
    failed &&
    failed.status !== AGENT_STEP_STATUS.passed &&
    !failed.interrupted &&
    failedAgent &&
    LOOP_BACK_ROLES.has(failedAgent.role)
  ) {
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
  // Haben schon alle bestanden, läuft wenigstens der letzte Agent noch einmal.
  if (position === ordered.length && position > 0) {
    done.pop();
    position -= 1;
  }
  return position;
}

/** Stand (Commit) des Auftrags-Branchs im Arbeitsordner; null ohne Git oder wenn git scheitert. */
export async function branchHead(ctx: RunContext): Promise<string | null> {
  if (!ctx.branch) return null;
  const { git } = gitHelpers(ctx.execute, ctx.options.cwd);
  const head = await git('rev-parse', 'HEAD');
  return head.exitCode === 0 && /^[0-9a-f]{7,64}$/.test(head.output) ? head.output : null;
}

/** Stand des Auftrags-Branchs am Schritt festhalten (nach dem Commit des Agents). */
export async function recordStepCommit(ctx: RunContext, stepId: string | undefined): Promise<void> {
  if (!stepId) return;
  const sha = await branchHead(ctx);
  if (!sha) return;
  await ctx.pool.query(`UPDATE agent_run_steps SET commit_sha = $2 WHERE id = $1`, [stepId, sha]);
}

const clock = (date: Date): string =>
  date.toLocaleString('de-CH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * Hat der Tester genau diesen Stand des Auftrags-Branchs schon bestanden und steht er noch, wird sein Ergebnis
 * übernommen statt die Tests erneut laufen zu lassen: ein eigener Schritt „bestanden (unverändert seit …)“ mit der
 * alten Ausgabe, die wie sonst an die folgenden Agents geht. Liefert false, wenn der Tester laufen muss.
 */
export async function takeOverUnchangedTester(
  ctx: RunContext,
  agent: WorkflowAgent,
  stepPosition: number,
): Promise<boolean> {
  if (agent.role !== 'tester' || !ctx.branch || ctx.item.agentId) return false;
  const sha = await branchHead(ctx);
  if (!sha) return false;
  const previous = (
    await ctx.pool.query<{ output: string; started_at: Date | string | null }>(
      `SELECT s.output, s.started_at FROM agent_run_steps s JOIN agent_runs r ON r.id = s.run_id
        WHERE r.development_id = $1 AND r.id <> $2 AND s.status = '${AGENT_STEP_STATUS.passed}' AND s.commit_sha = $3
          AND COALESCE(s.workflow_step_id::text, s.agent_id::text) = $4
        ORDER BY s.started_at DESC LIMIT 1`,
      [ctx.item.id, ctx.runId, sha, agent.stepId ?? agent.id],
    )
  ).rows[0];
  // Nur ein echter Treffer mit Ausgabe zählt – nie ein Ergebnis übernehmen, das es nicht gibt.
  if (typeof previous?.output !== 'string') return false;
  const since = previous.started_at ? clock(new Date(previous.started_at)) : 'dem letzten Lauf';
  const note = `Bestanden (unverändert seit ${since}): Der Tester hat den Stand ${sha.slice(0, 8)} schon geprüft, seit dem letzten Lauf hat sich am Auftrags-Branch nichts geändert.`;
  const output = `${note}\n\n${previous.output}`;
  const stepId = (
    await ctx.pool.query<{ id: string }>(
      `INSERT INTO agent_run_steps (run_id, position, agent_id, agent_name, phase, status, workflow_step_id, output,
                                    commit_sha, exit_code, duration_ms)
       VALUES ($1, $2, (SELECT id FROM agents WHERE id = $3::uuid), $4, $5, '${AGENT_STEP_STATUS.passed}',
               (SELECT id FROM workflow_steps WHERE id = $6::uuid), $7, $8, 0, 0)
       RETURNING id`,
      [ctx.runId, stepPosition, agent.id, agent.name, agent.phase, agent.stepId ?? null, output, sha],
    )
  ).rows[0]?.id;
  await logEvent(ctx.pool, stepId, note);
  console.info(`[${ctx.item.id}] ${agent.phase} › ${agent.name}: ${note}`);
  ctx.done.push({
    agentName: agent.name,
    phase: agent.phase,
    status: AGENT_STEP_STATUS.passed,
    output: previous.output,
  });
  return true;
}
