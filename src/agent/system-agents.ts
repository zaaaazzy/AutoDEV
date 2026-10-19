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

/** Models chosen in the dashboard (app_settings "model:<role>") override the worker environment. */
export async function applyModelSettings(pool: Pool): Promise<void> {
  const rows = (
    await pool.query<{ key: string; value: string }>(`SELECT key, value FROM app_settings WHERE key LIKE 'model:%'`)
  ).rows;
  for (const [, , role] of SYSTEM_ROLES) {
    const chosen = rows.find((row) => row.key === `model:${role}`)?.value.trim();
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

/** Reads a stored "command:<role>" value; anything but a non-empty string array counts as no command. */
export function parseStoredCommand(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  try {
    const command: unknown = JSON.parse(value);
    return Array.isArray(command) && command.length && command.every((part) => typeof part === 'string')
      ? (command as string[])
      : null;
  } catch {
    return null;
  }
}

/** External CLI chosen for a system role in the dashboard (e.g. copilot, claude); null means the local model. */
export async function systemCommand(pool: Pool, role: string): Promise<string[] | null> {
  if (!SYSTEM_ROLES.some(([, , value]) => value === role)) return null;
  const row = (
    await pool.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = $1`, [`command:${role}`])
  ).rows[0];
  return parseStoredCommand(row?.value);
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
