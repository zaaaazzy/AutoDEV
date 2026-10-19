import type { Pool } from 'pg';
import { DEFAULT_OLLAMA_URL, patientFetch, resolveModel } from './ollama-client.js';

export interface SystemAgent {
  command?: string[] | null;
  name: string;
  description: string;
  role: string;
  model: string;
  envKey: string;
}

export const SYSTEM_ROLES = [
  ['Dashboard-Assistent', 'Beantwortet Chat-Fragen, prüft Dienste und löst Probleme im Projektumfang.', 'assistant'],
  ['Problemanalyse', 'Analysiert blockierte Aufträge und schlägt Lösungen vor.', 'analyst'],
  ['Schnellschätzung', 'Schätzt Aufwand und Nutzen neuer Ideen (Auftragsautor-Modell).', 'author'],
] as const;

const envKey = (role: string): string => `DEV_LOG_OLLAMA_MODEL_${role.toUpperCase()}`;
const startupEnvironment = { ...process.env };

export function systemAgents(environment: NodeJS.ProcessEnv = process.env): SystemAgent[] {
  return SYSTEM_ROLES.map(([name, description, role]) => ({
    name,
    description,
    role,
    model: resolveModel(role, environment),
    envKey: envKey(role),
  }));
}

export interface SystemAgentSettings {
  model: string | null;
  command: string[] | null;
  allowTools: boolean;
}

/** Dashboard choices per system role (table system_agent_settings); roles without a row use the defaults. */
export async function loadSystemSettings(pool: Pool): Promise<Map<string, SystemAgentSettings>> {
  const rows = (
    await pool.query<{ role: string; model: string | null; command: unknown; allow_tools: boolean }>(
      `SELECT role, model, command, allow_tools FROM system_agent_settings`,
    )
  ).rows;
  return new Map(
    rows.map((row) => [
      row.role,
      { model: row.model?.trim() || null, command: asCommand(row.command), allowTools: row.allow_tools },
    ]),
  );
}

/** Models chosen in the dashboard override the worker environment. */
export async function applyModelSettings(pool: Pool): Promise<void> {
  const settings = await loadSystemSettings(pool);
  for (const [, , role] of SYSTEM_ROLES) {
    const chosen = settings.get(role)?.model;
    const original = startupEnvironment[envKey(role)];
    if (chosen) process.env[envKey(role)] = chosen;
    else if (original === undefined) delete process.env[envKey(role)];
    else process.env[envKey(role)] = original;
  }
}

async function installedModels(): Promise<string[]> {
  const baseUrl = (process.env.DEV_LOG_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
  const response = await patientFetch(`${baseUrl}/api/tags`);
  const body = (await response.json()) as { models?: { name: string }[] };
  return (body.models ?? []).map((model) => model.name).sort();
}

/** The worker owns the environment and reaches Ollama, so it publishes models and choices for the dashboard. */
export async function publishSystemAgents(pool: Pool): Promise<void> {
  await applyModelSettings(pool);
  const models = await installedModels().catch(() => []);
  const upsert = `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  await pool.query(upsert, ['system_agents', JSON.stringify(systemAgents())]);
  await pool.query(upsert, ['ollama_models', JSON.stringify(models)]);
}

/** Anything but a non-empty string array counts as no command. */
export function asCommand(value: unknown): string[] | null {
  return Array.isArray(value) && value.length && value.every((part) => typeof part === 'string')
    ? (value as string[])
    : null;
}

async function systemSetting(pool: Pool, role: string): Promise<SystemAgentSettings | undefined> {
  if (!SYSTEM_ROLES.some(([, , value]) => value === role)) return undefined;
  const row = (
    await pool.query<{ command: unknown; allow_tools: boolean }>(
      `SELECT command, allow_tools FROM system_agent_settings WHERE role = $1`,
      [role],
    )
  ).rows[0];
  return row && { model: null, command: asCommand(row.command), allowTools: row.allow_tools };
}

/** External CLI chosen for a system role in the dashboard (e.g. copilot, claude); null means the local model. */
export async function systemCommand(pool: Pool, role: string): Promise<string[] | null> {
  return (await systemSetting(pool, role))?.command ?? null;
}

/** Roles whose CLI loses its permission flags unless the user allows full tool access. */
export const RESTRICTED_ROLES = ['analyst', 'author'] as const;

/** Dashboard CLI of a restricted role: read-only by default, with the preset's flags only if the user allowed it. */
export async function restrictedSystemCommand(pool: Pool, role: string): Promise<string[] | null> {
  const setting = await systemSetting(pool, role);
  if (!setting?.command) return null;
  return setting.allowTools ? setting.command : readOnlyCommand(setting.command);
}

/** CLI flags that grant write or shell access without asking; flags in VALUE_FLAGS also consume the next part. */
const PERMISSION_FLAGS = new Set([
  '--permission-mode',
  '--dangerously-skip-permissions',
  '--allowedTools',
  '--allowed-tools',
  '--allow-all-tools',
  '--allow-all-paths',
  '--allow-tool',
  '--yolo',
  '-y',
  '--approval-mode',
]);
const VALUE_FLAGS = new Set([
  '--permission-mode',
  '--allowedTools',
  '--allowed-tools',
  '--allow-tool',
  '--approval-mode',
]);

/** Removes permission-granting flags so a read-only system role (analysis, estimation) cannot edit or run commands. */
export function readOnlyCommand(command: string[]): string[] {
  const result: string[] = [];
  let skipValue = false;
  for (const part of command) {
    const [flag = part] = part.split('=');
    if (skipValue) skipValue = false;
    else if (!PERMISSION_FLAGS.has(flag)) result.push(part);
    else skipValue = VALUE_FLAGS.has(flag) && !part.includes('=');
  }
  return result;
}
