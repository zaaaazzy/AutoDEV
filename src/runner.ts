import { isUuid } from './validation.js';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { materializeAttachments } from './attachments.js';
import { type KnownBug, loadKnownBugs } from './bugs.js';
import { backfillFailures, registerFailure, resumeBlockedByBug } from './autofix.js';
import { startProgress } from './chat-progress.js';
import { loadProjectContext, withProjectContext } from './project-context.js';
import { isShuttingDown, killGroup } from './shutdown.js';
import { type CommandExecutor, type CommandResult, redactOutput, runCommand } from './command.js';
import { readManual, saveOrderDoc, syncRepoDocs, upsertDoc } from './docs.js';
import { commitTaskToGit, syncSprintToGit } from './git-sync.js';
import { estimateIdeas } from './estimation.js';
import { draftRequirements } from './requirements.js';
import { runOllamaAgent } from './ollama-agent.js';
import { generateSprintReport } from './reports.js';
import { runTestAgent } from './test-agent.js';

export const PHASE_ORDER = ['pre_task', 'while_task', 'after_task'] as const;
const PROMPT_PLACEHOLDER = '{prompt}';
const PREVIOUS_OUTPUT_CHARS = 1_500;
const MANUAL_TITLE = 'Anwendungshandbuch';
const USER_MANUAL_TITLE = 'Benutzerhandbuch';
const MANUAL_PROMPT_CHARS = 12_000;
const MIN_MANUAL_CHARS = 200;

export interface WorkItem {
  id: string;
  projectSlug: string;
  title: string;
  description: string;
  kind?: string;
  bugId?: string | null;
  sprintId?: string | null;
  ideationId?: string | null;
  agentId?: string | null;
  risks?: string;
}

export interface PromptExtras {
  bugs?: KnownBug[];
  manual?: string;
  images?: string[];
}

/** Runs an agent that has no command of its own (built-in tester or local model). */
export type BuiltinAgent = (
  context: { pool: Pool; item: WorkItem; agent: WorkflowAgent; prompt: string; cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<CommandResult>;

export interface WorkflowAgent {
  id: string;
  name: string;
  role: string;
  phase: string;
  position: number;
  instructions: string;
  command: string[] | null;
}

export interface StepSummary {
  agentName: string;
  phase: string;
  status: string;
  output: string;
}

export interface RunnerOptions {
  project: string;
  cwd: string;
  itemId?: string;
  limit: number;
  timeoutMs: number;
  watch: boolean;
  intervalMs: number;
  all?: boolean;
}

export function parseRunnerOptions(args: string[], cwd = process.env.INIT_CWD ?? process.cwd()): RunnerOptions {
  const values = new Map<string, string>();
  let watch = false;
  let all = false;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--watch') {
      watch = true;
      continue;
    }
    if (key === '--all') {
      all = true;
      continue;
    }
    const value = args[index + 1];
    if (!['--project', '--cwd', '--item', '--limit', '--timeout-minutes', '--interval-seconds'].includes(key ?? '')) {
      throw new Error(`Unknown runner option: ${key}`);
    }
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${key}.`);
    }
    values.set(key as string, value);
    index += 1;
  }
  const project = all ? '*' : values.get('--project');
  if (!project || (!all && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(project))) {
    throw new Error('--project must be a lowercase project slug (or use --all).');
  }
  const itemId = values.get('--item');
  if (itemId !== undefined && !isUuid(itemId)) {
    throw new Error('--item must be a UUID.');
  }
  const limit = Number(values.get('--limit') ?? 1);
  const minutes = Number(values.get('--timeout-minutes') ?? 30);
  const seconds = Number(values.get('--interval-seconds') ?? 30);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('--limit must be an integer between 1 and 50.');
  }
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 240) {
    throw new Error('--timeout-minutes must be between 1 and 240.');
  }
  if (!Number.isFinite(seconds) || seconds < 5 || seconds > 3600) {
    throw new Error('--interval-seconds must be between 5 and 3600.');
  }
  return {
    project, cwd: resolve(cwd, values.get('--cwd') ?? '.'), itemId, limit, timeoutMs: minutes * 60_000,
    watch, intervalMs: seconds * 1000, all,
  };
}

export function buildPrompt(
  agent: WorkflowAgent,
  item: WorkItem,
  previous: StepSummary[],
  extras: PromptExtras = {},
): string {
  const history = previous.map((step) =>
    `### ${step.agentName} (${step.phase}, ${step.status})\n${step.output.trim().slice(-PREVIOUS_OUTPUT_CHARS)}`);
  const bugs = (extras.bugs ?? []).map((bug) =>
    `- [${bug.status === 'fixed' ? 'behoben' : 'offen'} / ${bug.severity}] ${bug.title}`
    + `${bug.description ? ` – ${bug.description.slice(0, 200)}` : ''}`
    + `${bug.fixNotes ? ` | Lösung: ${bug.fixNotes.slice(0, 300)}` : ''}`);
  return [
    `Du bist der Agent "${agent.name}" (Rolle: ${agent.role}) in der Phase ${agent.phase}.`,
    `## Anweisung\n${agent.instructions || 'Keine zusätzliche Anweisung.'}`,
    `## Entwicklungsauftrag ${item.id}${item.kind === 'bug' ? ' (Bugfix)' : ''}\nTitel: ${item.title}\n${item.description}`,
    item.risks?.trim() ? `## Risiken (vom Bug-Wächter geprüft)\n${item.risks.trim()}` : '',
    extras.images?.length
      ? `## Angehängte Bilder (Referenzen aus dem Ideationboard, relativ zum Projektordner)\n${extras.images.map((path) => `- ${path}`).join('\n')}`
      : '',
    bugs.length
      ? `## Bekannte Bugs – offene und behobene. Wiederhole diese Fehler nicht.\n${bugs.join('\n')}`
      : '',
    extras.manual !== undefined
      ? `## Bisheriges Handbuch (${agent.role === 'user_manual_writer' ? USER_MANUAL_TITLE : MANUAL_TITLE})\n${extras.manual.slice(0, MANUAL_PROMPT_CHARS) || '(noch leer – erstelle es vollständig)'}`
      : '',
    history.length ? `## Ergebnisse vorheriger Agents\n${history.join('\n\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

/** Replaces the {prompt} placeholder, or appends the prompt as the last argument. */
export function buildInvocation(command: string[], prompt: string): string[] {
  return command.includes(PROMPT_PLACEHOLDER)
    ? command.map((part) => (part === PROMPT_PLACEHOLDER ? prompt : part))
    : [...command, prompt];
}

export function agentEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DEV_LOG_')));
}

export async function loadWorkflow(pool: Pool, projectSlug: string): Promise<WorkflowAgent[]> {
  const result = await pool.query<WorkflowAgent>(
    `SELECT id, name, role, phase, position, instructions, command
       FROM agents
      WHERE project_slug = $1 AND enabled
      ORDER BY CASE phase WHEN 'pre_task' THEN 0 WHEN 'while_task' THEN 1 ELSE 2 END, position, created_at`,
    [projectSlug],
  );
  return result.rows;
}

/** Planned items of the active sprint or assigned directly to an agent, most important first. */
export async function selectItems(pool: Pool, options: RunnerOptions): Promise<WorkItem[]> {
  const columns = `d.id, d.project_slug AS "projectSlug", d.title, d.description, d.kind, d.bug_id AS "bugId", d.sprint_id AS "sprintId", d.ideation_id AS "ideationId", d.agent_id AS "agentId", d.risks`;
  if (options.itemId) {
    const result = await pool.query<WorkItem>(
      `SELECT ${columns} FROM development_items d WHERE d.id = $1 AND d.project_slug = $2`,
      [options.itemId, options.project],
    );
    return result.rows;
  }
  const result = await pool.query<WorkItem>(
    `SELECT ${columns}
       FROM development_items d
       LEFT JOIN sprints s ON s.id = d.sprint_id
      WHERE d.project_slug = $1 AND d.status = 'planned' AND (s.status = 'active' OR d.agent_id IS NOT NULL OR d.auto_run)
      ORDER BY CASE d.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, d.created_at
      LIMIT $2`,
    [options.project, options.limit],
  );
  return result.rows;
}

export function defaultAgentCommand(environment: NodeJS.ProcessEnv = process.env): string[] | null {
  const raw = environment.DEV_LOG_AGENT_COMMAND?.trim();
  if (!raw) {
    return null;
  }
  if (raw.startsWith('[')) {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((part) => typeof part === 'string') && parsed.length ? parsed as string[] : null;
  }
  return raw.split(/\s+/);
}

export function parseTestCommands(parsed: unknown): string[][] | null {
  return Array.isArray(parsed) && parsed.length && parsed.every((command) =>
    Array.isArray(command) && command.length && command.every((part) => typeof part === 'string'))
    ? parsed as string[][]
    : null;
}

async function testCommands(pool: Pool, project: string, environment: NodeJS.ProcessEnv = process.env): Promise<string[][]> {
  const stored = (await pool.query<{ commands: unknown }>(
    'SELECT test_commands AS commands FROM projects WHERE slug = $1', [project],
  )).rows[0]?.commands;
  const raw = environment.DEV_LOG_TEST_COMMANDS?.trim();
  return parseTestCommands(stored) ?? (raw ? parseTestCommands(JSON.parse(raw)) : null) ?? [['npm', 'run', 'build'], ['npm', 'test']];
}

/** Built-in agents: the tester runs build and tests (and records a test run), all other roles use the local model. */
export const runBuiltinAgent: BuiltinAgent = async ({ pool, item, agent, prompt, cwd, timeoutMs, signal }) => {
  if (agent.role === 'tester') {
    const startedAt = Date.now();
    const runId = await runTestAgent({
      project: item.projectSlug, cwd, commands: await testCommands(pool, item.projectSlug),
      existingProject: true, timeoutMs, signal, env: agentEnvironment(),
    }, pool);
    const steps = await pool.query<{ command: string; status: string; output: string }>(
      'SELECT command, status, output FROM test_run_steps WHERE run_id = $1 ORDER BY position', [runId],
    );
    const failed = steps.rows.some((step) => step.status !== 'passed');
    const output = steps.rows.map((step) =>
      `$ ${step.command} → ${step.status}\n${step.status === 'passed' ? step.output.slice(-400) : step.output.slice(-3000)}`).join('\n\n');
    return { exitCode: failed ? 1 : 0, durationMs: Date.now() - startedAt, output: `Testlauf ${runId}\n\n${output}` };
  }
  return runOllamaAgent({ prompt, role: agent.role, cwd, timeoutMs, signal });
};

export interface WorkItemOptions {
  cwd: string;
  timeoutMs: number;
  execute?: CommandExecutor;
  builtin?: BuiltinAgent;
}

async function afterStep(
  pool: Pool,
  item: WorkItem,
  agent: WorkflowAgent,
  output: string,
): Promise<void> {
  if (agent.role === 'documenter' && output.trim()) {
    await saveOrderDoc(pool, { projectSlug: item.projectSlug, developmentId: item.id, title: item.title, content: output });
  } else if (agent.role === 'manual_writer' && output.trim().length >= MIN_MANUAL_CHARS) {
    await upsertDoc(pool, { projectSlug: item.projectSlug, kind: 'manual', title: MANUAL_TITLE, content: output });
  } else if (agent.role === 'user_manual_writer' && output.trim().length >= MIN_MANUAL_CHARS) {
    await upsertDoc(pool, { projectSlug: item.projectSlug, kind: 'manual', title: USER_MANUAL_TITLE, content: output });
  } else if (agent.role === 'developer' && item.bugId) {
    await pool.query('UPDATE bugs SET fix_notes = $2, updated_at = NOW() WHERE id = $1', [item.bugId, output.trim().slice(-1500)]);
  }
}

export async function runWorkItem(
  pool: Pool,
  item: WorkItem,
  agents: WorkflowAgent[],
  options: WorkItemOptions,
): Promise<'passed' | 'failed' | 'skipped'> {
  const execute = options.execute ?? runCommand;
  const builtin = options.builtin ?? runBuiltinAgent;
  await pool.query(
    `UPDATE agent_runs SET status = 'failed', completed_at = NOW()
      WHERE development_id = $1 AND status = 'running' AND started_at < NOW() - INTERVAL '3 hours'`,
    [item.id],
  );
  const claim = await pool.query<{ id: string }>(
    `INSERT INTO agent_runs (project_slug, development_id, status)
     VALUES ($1, $2, 'running')
     ON CONFLICT (development_id) WHERE status = 'running' DO NOTHING
     RETURNING id`,
    [item.projectSlug, item.id],
  );
  const runId = claim.rows[0]?.id;
  if (!runId) {
    console.info(`Skipping ${item.id}: a run is already in progress.`);
    return 'skipped';
  }
  await pool.query(`UPDATE development_items SET status = 'in_progress', updated_at = NOW() WHERE id = $1`, [item.id]);

  const done: StepSummary[] = [];
  let passed = true;
  let interrupted = false;
  const ordered = agents
    .filter((agent) => item.agentId ? agent.id === item.agentId
      : !(agent.role === 'author' && item.ideationId) && !(agent.role === 'bug_reviewer' && item.risks?.trim()))
    .sort((left, right) =>
      PHASE_ORDER.indexOf(left.phase as never) - PHASE_ORDER.indexOf(right.phase as never)
      || left.position - right.position);
  try {
    if (!ordered.length) throw new Error('Der zugewiesene Agent ist nicht mehr aktiviert oder vorhanden.');
    const bugs = await loadKnownBugs(pool, item.projectSlug).catch(() => []);
    const images = await materializeAttachments(pool, item.ideationId, item.id, options.cwd).catch(() => []);
    const fallbackCommand = defaultAgentCommand();
    const projectContext = await loadProjectContext(pool, item.projectSlug);
    for (const [position, agent] of ordered.entries()) {
      const step = { agentName: agent.name, phase: agent.phase };
      console.info(`[${item.id}] ${agent.phase} › ${agent.name}`);
      const stepRow = await pool.query<{ id: string }>(
        `INSERT INTO agent_run_steps (run_id, position, agent_id, agent_name, phase, status)
         VALUES ($1, $2, $3, $4, $5, 'running') RETURNING id`,
        [runId, position, agent.id, agent.name, agent.phase],
      );
      const manual = agent.role === 'manual_writer' || agent.role === 'user_manual_writer'
        ? await readManual(pool, item.projectSlug, agent.role === 'manual_writer' ? MANUAL_TITLE : USER_MANUAL_TITLE).catch(() => '') : undefined;
      const prompt = withProjectContext(projectContext, buildPrompt(agent, item, done, { bugs, manual, images }));
      const command = agent.command?.length ? agent.command : agent.role === 'tester' ? null : fallbackCommand;
      let result: CommandResult = { exitCode: 1, durationMs: 0, output: '' };
      const stepAbort = new AbortController();
      let stepPid = 0;
      let cancelled = false;
      let stopWatching = (): void => undefined;
      // Ein „Abbrechen“ aus der Oberfläche beendet den Schritt sofort, auch wenn der Agent selbst nicht reagiert.
      const cancelRequested = new Promise<CommandResult>((resolveCancel) => {
        const watcher = setInterval(() => {
          void pool.query<{ cancel_requested: boolean }>('SELECT cancel_requested FROM agent_run_steps WHERE id = $1', [stepRow.rows[0]?.id])
            .then(({ rows }) => {
              if (!rows[0]?.cancel_requested || cancelled) return;
              cancelled = true;
              stepAbort.abort();
              if (stepPid) killGroup(stepPid);
              resolveCancel({ exitCode: 130, durationMs: 0, output: 'Vom Benutzer abgebrochen.' });
            }).catch(() => undefined);
        }, 1500);
        stopWatching = () => clearInterval(watcher);
      });
      let lastLiveWrite = 0;
      const onOutput = (partial: string): void => {
        if (Date.now() - lastLiveWrite < 1500) return;
        lastLiveWrite = Date.now();
        void pool.query('UPDATE agent_run_steps SET output = $2 WHERE id = $1 AND status = $3',
          [stepRow.rows[0]?.id, redactOutput(partial, process.env), 'running']).catch(() => undefined);
      };
      const progress = await startProgress(pool, item.projectSlug,
        [`${agent.name} beginnt (Schritt ${position + 1}/${ordered.length}) …`, `${agent.name} arbeitet an „${item.title}“ …`, `${agent.name} ist noch dabei …`],
        { stepId: stepRow.rows[0]?.id, silent: true });
      const work = (async (): Promise<void> => { try {
        if (agent.role === 'tester' && !agent.command?.length && fallbackCommand) {
          // Der Tester entwickelt zuerst Tests anhand der Angaben des Entwicklers und lässt danach Build und Tests laufen.
          const written = await execute(buildInvocation(fallbackCommand, `${prompt}\n\n## Aufgabe\nSchreibe oder ergänze die Tests für diesen Auftrag anhand der Angaben des Entwicklers. Führe sie nicht aus; das übernimmt anschließend der Testlauf.`),
            options.cwd, { timeoutMs: options.timeoutMs, env: agentEnvironment(), onOutput }).catch((error: unknown) => ({ exitCode: 1, durationMs: 0, output: error instanceof Error ? error.message : String(error) }));
          const run = await builtin({ pool, item, agent, prompt, cwd: options.cwd, timeoutMs: options.timeoutMs, signal: stepAbort.signal });
          result = { ...run, durationMs: run.durationMs + written.durationMs, output: `## Entwickelte Tests\n${redactOutput(written.output, process.env).trim().slice(-1500)}\n\n## Testlauf\n${run.output}` };
        } else result = command
          ? await execute(buildInvocation(command, prompt), options.cwd, {
            timeoutMs: options.timeoutMs,
            env: agentEnvironment(),
            onOutput,
            onSpawn: (pid) => void (stepPid = pid, pool.query(
              `UPDATE agent_run_steps SET pid = $2, pid_started_at = NOW() WHERE id = $1`, [stepRow.rows[0]?.id, pid],
            ).catch(() => undefined)),
          })
          : await builtin({ pool, item, agent, prompt, cwd: options.cwd, timeoutMs: options.timeoutMs, signal: stepAbort.signal });
      } catch (error) {
        result = { exitCode: 1, durationMs: 0, output: error instanceof Error ? error.message : String(error) };
      } })();
      result = await Promise.race([work.then(() => result), cancelRequested]);
      stopWatching();
      await progress.stop();
      const output = redactOutput(result.output, process.env);
      if (isShuttingDown()) {
        interrupted = true;
        passed = false;
        await pool.query(
          `UPDATE agent_run_steps SET status = 'failed', exit_code = $2, duration_ms = $3, output = $4 WHERE id = $1`,
          [stepRow.rows[0]?.id, result.exitCode, result.durationMs, `${output}\nUnterbrochen: Der Worker wurde beendet.`],
        );
        break;
      }
      const stepPassed = result.exitCode === 0 && !cancelled;
      await pool.query(
        `UPDATE agent_run_steps SET status = $2, exit_code = $3, duration_ms = $4, output = $5 WHERE id = $1`,
        [stepRow.rows[0]?.id, stepPassed ? 'passed' : 'failed', result.exitCode, result.durationMs, output],
      );
      done.push({ ...step, status: stepPassed ? 'passed' : 'failed', output });
      if (!stepPassed) {
        passed = false;
        if (!cancelled) await registerFailure(pool, item, agent.name, output).catch((error) => console.error('Bug report failed:', error));
        break;
      }
      await afterStep(pool, item, agent, output).catch((error) => console.error('Post-step handling failed:', error));
    }
  } catch (error) {
    passed = false;
    console.error(`Run ${runId} aborted:`, error);
  } finally {
    await pool.query(`UPDATE agent_runs SET status = $2, completed_at = NOW() WHERE id = $1`,
      [runId, passed ? 'passed' : 'failed']);
    // Unterbrochene Aufträge gehen zurück auf „Geplant“ (Agent-Zuweisung bleibt), damit sie beim Neustart weiterlaufen.
    if (interrupted) {
      await pool.query(`UPDATE development_items SET status = 'planned', updated_at = NOW() WHERE id = $1`, [item.id]);
    } else if (item.agentId) {
      // Einzelner Agent (Play): stellt den früheren Status wieder her; ein blockierter Auftrag läuft nach Erfolg regulär weiter.
      await pool.query(
        `UPDATE development_items SET agent_id = NULL, return_status = NULL, updated_at = NOW(),
                status = CASE WHEN NOT $2 THEN 'blocked' WHEN return_status IS NULL OR return_status = 'blocked' THEN 'planned' ELSE return_status END
          WHERE id = $1`, [item.id, passed]);
    } else {
      await pool.query(`UPDATE development_items SET status = $2, agent_id = NULL, return_status = NULL, updated_at = NOW() WHERE id = $1`,
        [item.id, passed ? 'done' : 'blocked']);
    }
    if (passed && !interrupted && !item.agentId && item.sprintId) {
      const sprint = await pool.query<{ name: string }>('SELECT name FROM sprints WHERE id = $1', [item.sprintId]).catch(() => null);
      if (sprint?.rows[0]) await commitTaskToGit(options.cwd, item, sprint.rows[0].name, execute);
    }
    if (passed && item.bugId && !item.agentId) await resumeBlockedByBug(pool, item.bugId).catch(() => undefined);
  }
  return passed ? 'passed' : 'failed';
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
  // Aufträge im aktiven Sprint laufen automatisch, auch wenn sie noch im Backlog-Status stehen.
  await pool.query(
    `UPDATE development_items SET status = 'planned', updated_at = NOW()
      WHERE project_slug = $1 AND status = 'backlog' AND sprint_id IN (SELECT id FROM sprints WHERE project_slug = $1 AND status = 'active')`,
    [options.project]);
  await backfillFailures(pool, options.project).catch((error) => console.error('Fehler-Nachtrag fehlgeschlagen:', error));
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
    `SELECT id FROM sprints WHERE project_slug = $1 AND status = 'active'`, [options.project],
  );
  if (active.rows[0]) {
    await generateSprintReport(pool, active.rows[0].id);
  }
  await syncSprintToGit(pool, options.project, options.cwd, execute);
  return results;
}
