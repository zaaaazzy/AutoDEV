import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { isUuid } from '../core/validation.js';
import type { RunnerOptions, WorkItem, WorkflowAgent } from './runner-types.js';

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
    (raw ? parseTestCommands(JSON.parse(raw)) : null) ?? [
      ['npm', 'run', 'build'],
      ['npm', 'test'],
    ]
  );
}
