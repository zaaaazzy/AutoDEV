import { PHASE_SQL_ORDER } from '../core/workflow-phases.js';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { isUuid } from '../core/validation.js';
import { awaitsBugApprovalSql } from '../core/bug-trust.js';
import type { RunnerOptions, WorkItem, WorkflowAgent } from './runner-types.js';
import { DEVELOPMENT_STATUS, SPRINT_STATUS } from '../core/status.js';

/** Höchstes Zeitlimit eines Agent-Schritts (--timeout-minutes); daraus leitet sich die Schwelle für verwaiste Läufe ab. */
export const MAX_TIMEOUT_MINUTES = 240;

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
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_TIMEOUT_MINUTES) {
    throw new Error(`--timeout-minutes must be between 1 and ${MAX_TIMEOUT_MINUTES}.`);
  }
  if (!Number.isFinite(seconds) || seconds < 5 || seconds > 3600) {
    throw new Error('--interval-seconds must be between 5 and 3600.');
  }
  return {
    project,
    cwd: resolve(cwd, values.get('--cwd') ?? '.'),
    itemId,
    limit,
    timeoutMs: minutes * 60_000,
    watch,
    intervalMs: seconds * 1000,
    all,
  };
}

/** Zeile aus workflow_steps bzw. agents samt Aktiv-Status (Schritt pausiert, Agent deaktiviert). */
export type WorkflowRow = WorkflowAgent & { enabled: boolean; agentEnabled?: boolean };

/**
 * Einzige Regel für den Ablauf eines Projekts: Hat es Workflow-Schritte, gelten nur diese (Phase, Position,
 * Anweisung, pausiert); ein deaktivierter Agent läuft in keinem seiner Schritte. Ohne Schritte (ältere Projekte)
 * gelten Phase, Position und Aktiv-Status am Agent. Die Agent-Routen schreiben deshalb in die Schritte mit.
 */
export function workflowFromRows(steps: WorkflowRow[], agents: WorkflowRow[]): WorkflowAgent[] {
  const strip = (row: WorkflowRow): WorkflowAgent => {
    const agent: Partial<WorkflowRow> = { ...row };
    delete agent.enabled;
    delete agent.agentEnabled;
    return agent as WorkflowAgent;
  };
  if (steps.length) return steps.filter((step) => step.enabled && step.agentEnabled !== false).map(strip);
  return agents.filter((agent) => agent.enabled).map(strip);
}

export async function loadWorkflow(pool: Pool, projectSlug: string): Promise<WorkflowAgent[]> {
  // Workflow-Schritte (Agents → Workflow): derselbe Agent darf mehrfach vorkommen, je mit eigener Anweisung.
  const steps = await pool.query<WorkflowRow>(
    `SELECT a.id, a.name, a.role, s.phase, s.position, a.instructions, a.command,
            a.allowed_commands AS "allowedCommands", a.file_scope AS "fileScope", a.handoff_to AS "handoffTo",
            s.id AS "stepId", s.instructions AS "stepInstructions", s.enabled, a.enabled AS "agentEnabled"
       FROM workflow_steps s JOIN agents a ON a.id = s.agent_id
      WHERE s.project_slug = $1
      ORDER BY ${PHASE_SQL_ORDER.replace('CASE phase', 'CASE s.phase')}, s.position, s.created_at`,
    [projectSlug],
  );
  if (steps.rows.length) return workflowFromRows(steps.rows, []);
  // Ältere Projekte ohne Schritte: Phase und Position am Agent.
  const result = await pool.query<WorkflowRow>(
    `SELECT id, name, role, phase, position, instructions, command, allowed_commands AS "allowedCommands",
            file_scope AS "fileScope", handoff_to AS "handoffTo", enabled
       FROM agents
      WHERE project_slug = $1
      ORDER BY ${PHASE_SQL_ORDER}, position, created_at`,
    [projectSlug],
  );
  return workflowFromRows([], result.rows);
}

/**
 * Planned items of the active sprint or assigned directly to an agent, most important first. Aufträge zu Bugs aus
 * fremden Quellen (Betrieb, GitHub) ohne Freigabe durch einen Menschen werden nie gewählt, auch nicht gezielt (--item).
 */
export async function selectItems(pool: Pool, options: RunnerOptions): Promise<WorkItem[]> {
  const columns = `d.id, d.project_slug AS "projectSlug", d.title, d.description, d.kind, d.bug_id AS "bugId", (SELECT source FROM bugs WHERE id = d.bug_id) AS "bugSource", d.sprint_id AS "sprintId", d.ideation_id AS "ideationId", d.agent_id AS "agentId", d.risks, d.category, d.effort_hours AS "effortHours", d.estimate_source AS "estimateSource", d.retry_count AS "retryCount"`;
  if (options.itemId) {
    const result = await pool.query<WorkItem>(
      `SELECT ${columns} FROM development_items d
        WHERE d.id = $1 AND d.project_slug = $2 AND NOT ${awaitsBugApprovalSql('d')}`,
      [options.itemId, options.project],
    );
    return result.rows;
  }
  const result = await pool.query<WorkItem>(
    `SELECT ${columns}
       FROM development_items d
       LEFT JOIN sprints s ON s.id = d.sprint_id
      WHERE d.project_slug = $1 AND d.status = '${DEVELOPMENT_STATUS.planned}' AND d.kind <> 'express'
        AND NOT ${awaitsBugApprovalSql('d')}
        -- auto_run nur ohne Sprint: Ein geplanter Sprint wartet auf seinen Start, ein abgeschlossener bzw. abgebrochener
        -- hält den Auftrag ohnehin an (sprintPaused) – er drehte sich sonst endlos (detachFromClosedSprints hängt ihn um).
        AND (s.status = '${SPRINT_STATUS.active}' OR d.agent_id IS NOT NULL OR (d.auto_run AND d.sprint_id IS NULL))
        -- Nutzungslimit des Agent-Kontos bzw. Arbeitsordner nicht sauber: erst nach dem Reset wieder starten. Beides gilt
        -- für das ganze Projekt, nicht nur für den Auftrag, der es bemerkt hat – sonst liefe jeder weitere Auftrag in
        -- dieselbe Wand (ein von Hand gestarteter Agent läuft trotzdem).
        AND (d.retry_after IS NULL OR d.retry_after <= NOW())
        AND (d.agent_id IS NOT NULL OR NOT EXISTS (
              SELECT 1 FROM development_items x WHERE x.project_slug = d.project_slug AND x.retry_after > NOW()))
        -- Pausierter Sprint: keine Aufträge starten (ausser ein einzelner Agent wurde von Hand gestartet).
        AND (s.paused_at IS NULL OR d.agent_id IS NOT NULL)
      ORDER BY d.sprint_rank NULLS LAST, CASE d.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, d.created_at
      LIMIT $2`,
    [options.project, options.limit],
  );
  return result.rows;
}

/**
 * JSON aus einer Umgebungsvariable; ungültig → Warnung und null. Ein Tippfehler darf keinen Auftrag mitten im Start
 * werfen lassen (der Auftrag stünde sonst bis zum Neustart auf „In Arbeit“).
 */
function envJson(name: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    console.warn(`[runner] ${name} ist kein gültiges JSON – Wert wird ignoriert.`);
    return null;
  }
}

export function defaultAgentCommand(environment: NodeJS.ProcessEnv = process.env): string[] | null {
  const raw = environment.DEV_LOG_AGENT_COMMAND?.trim();
  if (!raw) {
    return null;
  }
  if (raw.startsWith('[')) {
    const parsed = envJson('DEV_LOG_AGENT_COMMAND', raw);
    return Array.isArray(parsed) && parsed.every((part) => typeof part === 'string') && parsed.length
      ? (parsed as string[])
      : null;
  }
  return raw.split(/\s+/);
}

export function parseTestCommands(parsed: unknown): string[][] | null {
  return Array.isArray(parsed) &&
    parsed.length &&
    parsed.every(
      (command) => Array.isArray(command) && command.length && command.every((part) => typeof part === 'string'),
    )
    ? (parsed as string[][])
    : null;
}

/** Testbefehle des Projekts (Einstellung, sonst DEV_LOG_TEST_COMMANDS, sonst Build und npm test). */
export async function loadTestCommands(
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
    (raw ? parseTestCommands(envJson('DEV_LOG_TEST_COMMANDS', raw)) : null) ?? [
      ['npm', 'run', 'build'],
      ['npm', 'test'],
    ]
  );
}

/** Testbefehle je Auftrag (Tester-Schritt, mit {tests}/{files}); null = nicht gesetzt, dann gelten die Testbefehle. */
export async function loadOrderTestCommands(pool: Pool, project: string): Promise<string[][] | null> {
  const stored = (
    await pool.query<{ commands: unknown }>('SELECT order_test_commands AS commands FROM projects WHERE slug = $1', [
      project,
    ])
  ).rows[0]?.commands;
  return parseTestCommands(stored);
}
