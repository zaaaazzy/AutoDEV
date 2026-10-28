import { logged } from '../core/log.js';
import type { Pool } from 'pg';
import { DEFAULT_OLLAMA_URL, patientFetch, resolveModel } from './ollama-client.js';
import { defaultAgentCommand } from '../runner/runner-selection.js';

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
  ['Visionär', 'Analysiert das Projekt nur lesend und schlägt begründete Erweiterungsideen vor.', 'visionary'],
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
  const models = await installedModels().catch(logged('system-agents', []));
  const upsert = `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  await pool.query(upsert, ['system_agents', JSON.stringify(systemAgents())]);
  await pool.query(upsert, ['ollama_models', JSON.stringify(models)]);
  // Nur der Programmname von DEV_LOG_AGENT_COMMAND (Argumente könnten Schlüssel enthalten) – für die Anzeige.
  await pool.query(upsert, ['agent_fallback_command', JSON.stringify(fallbackProgram())]);
}

/** Programm aus DEV_LOG_AGENT_COMMAND (z. B. `claude`), null ohne bzw. bei ungültigem Wert. */
export function fallbackProgram(environment: NodeJS.ProcessEnv = process.env): string[] | null {
  try {
    const program = defaultAgentCommand(environment)?.[0]?.split('/').at(-1);
    return program ? [program] : null;
  } catch {
    return null;
  }
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
  return settingCommand(role, await systemSetting(pool, role));
}

/**
 * Befehl, den die Einstellung einer System-Rolle ergibt (null: keine CLI gewählt). Assistent mit allen Optionen;
 * Analyse und Schnellschätzung nur mit Freigabe; der Visionär bleibt immer lesend (kein Schalter).
 */
export function settingCommand(role: string, setting: SystemAgentSettings | undefined): string[] | null {
  const command = setting?.command;
  if (!command) return null;
  if (role === 'assistant') return command;
  if (role === 'visionary') return readOnlyCommand(command);
  if (!(RESTRICTED_ROLES as readonly string[]).includes(role)) return null;
  return setting.allowTools ? command : readOnlyCommand(command);
}

/**
 * CLI aus den Einstellungen für einen Lauf von runAuthorAgent ohne eigenen Projekt-Agent. „author“ fehlt bewusst:
 * seine Wahl gilt nur der Schnellschätzung, nicht dem Schreiben von Anforderungen. Routinen nehmen die CLI des
 * Assistenten, aber ohne dessen Rechte-Optionen.
 */
export async function dashboardCommand(pool: Pool, role: string): Promise<string[] | null> {
  if (role === 'routine') {
    const command = await systemCommand(pool, 'assistant');
    return command && readOnlyCommand(command);
  }
  if (role === 'author') return null;
  return settingCommand(role, await systemSetting(pool, role));
}

export interface SystemAgentUsage {
  /** `cli`: externe CLI; `ollama`: lokales Modell. */
  kind: 'cli' | 'ollama';
  /** Woher die Wahl stammt: Einstellung, DEV_LOG_AGENT_COMMAND des Workers oder lokales Modell. */
  source: 'settings' | 'environment' | 'model';
  command: string[] | null;
  model: string;
}

/**
 * Was ein Lauf der System-Rolle tatsächlich nimmt (ohne eigenen Projekt-Agent) – dieselbe Reihenfolge wie
 * runAuthorAgent: Einstellung, dann DEV_LOG_AGENT_COMMAND, sonst Ollama. Die Schnellschätzung kennt keinen
 * Umgebungs-Befehl.
 */
export function systemAgentUsage(
  role: string,
  setting: SystemAgentSettings | undefined,
  fallback: string[] | null,
  model: string,
): SystemAgentUsage {
  const chosen = settingCommand(role, setting);
  if (chosen) return { kind: 'cli', source: 'settings', command: chosen, model };
  if (fallback && role !== 'author') return { kind: 'cli', source: 'environment', command: fallback, model };
  return { kind: 'ollama', source: 'model', command: null, model };
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
  // Erweitern Zugriff bzw. Einstellungen (eigene Berechtigungen in einer Settings-Datei, weitere Ordner).
  '--settings',
  '--add-dir',
]);
const VALUE_FLAGS = new Set([
  '--permission-mode',
  '--allowedTools',
  '--allowed-tools',
  '--allow-tool',
  '--approval-mode',
  '--settings',
]);
/** Flags, die mehrere Werte nehmen (`--add-dir a b`): alle folgenden Teile bis zum nächsten Flag fallen weg. */
const MULTI_VALUE_FLAGS = new Set(['--add-dir']);

/** Removes permission-granting flags so a read-only system role (analysis, estimation) cannot edit or run commands. */
export function readOnlyCommand(command: string[]): string[] {
  const result: string[] = [];
  let skipValue = false;
  let skipValues = false;
  for (const part of command) {
    const [flag = part] = part.split('=');
    if (skipValues && !part.startsWith('-')) continue;
    skipValues = false;
    if (skipValue) skipValue = false;
    else if (!PERMISSION_FLAGS.has(flag)) result.push(part);
    else if (MULTI_VALUE_FLAGS.has(flag)) skipValues = !part.includes('=');
    else skipValue = VALUE_FLAGS.has(flag) && !part.includes('=');
  }
  return result;
}
