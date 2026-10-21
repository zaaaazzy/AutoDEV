import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { customRuleProblem } from './command-checks.js';
import {
  CREATE_TOOLS,
  EDIT_TOOLS,
  FILES_CREATE,
  FILES_EDIT,
  LOGS_COMMAND,
  NO_FILE_WRITE_ROLES,
  PERMISSION_GROUPS,
  READ_ONLY_ROLES,
  SERVICES_COMMAND,
  TRUSTED_ROLES,
  isToolRule,
  normalizeCommands,
  servicesRule,
  type PermissionGroup,
} from './permission-rules.js';

export {
  CREATE_TOOLS,
  DATABASE_COMMAND,
  DEFAULT_PERMISSION_GROUPS,
  EDIT_TOOLS,
  FILE_TOOLS,
  FILES_CREATE,
  FILES_EDIT,
  LEGACY_FILES_COMMAND,
  LOGS_COMMAND,
  NO_FILE_WRITE_ROLES,
  PERMISSION_GROUPS,
  READ_ONLY_PERMISSION_ROLE,
  READ_ONLY_ROLES,
  SERVICES_COMMAND,
  commandHelp,
  commandLabel,
  normalizeCommands,
  rulesAllow,
  type PermissionGroup,
} from './permission-rules.js';
export {
  CUSTOM_GROUP_ID,
  SECRET_IN_COMMAND,
  customRuleProblem,
  forbiddenSubcommand,
  gitOptionProblem,
  gitPathProblem,
  isAllowedCommand,
  isAssistantServiceCommand,
  npmOptionProblem,
  shellWords,
  withIgnoreScripts,
} from './command-checks.js';
export { COMPOSE_STARTING, composeViolation } from './compose-check.js';

/** Ordner außerhalb des Projekts, die diese Rollen lesen dürfen (z. B. Dienst-Logs unter ~/Library/Logs). */
export function extraReadDirectories(environment: NodeJS.ProcessEnv = process.env): string[] {
  const home = environment.HOME;
  return home ? [`${home}/Library/Logs`] : [];
}

/** Rechte eines Projekts: freigeschaltete Gruppen (null = alle) und eigene Gruppen dieses Projekts. */
export interface ProjectPermissions {
  enabled: string[] | null;
  custom: PermissionGroup[];
}

/** A database error fails the caller: without the project's choice every group would count as enabled. */
export async function loadProjectPermissions(
  pool: { query: <R>(sql: string, values: unknown[]) => Promise<{ rows: R[] }> },
  project: string,
): Promise<ProjectPermissions> {
  const [enabled, custom] = await Promise.all([
    pool
      .query<{ groups: string[] | null }>('SELECT agent_permissions AS groups FROM projects WHERE slug = $1', [project])
      .then((result) => result.rows[0]?.groups ?? null),
    pool
      .query<PermissionGroup>(
        'SELECT id, label, description, rules FROM project_permission_groups WHERE project_slug = $1 ORDER BY label',
        [project],
      )
      .then((result) => result.rows),
  ]);
  // Eigene Regeln werden beim Speichern geprüft (customRuleProblem). Ältere Zeilen aus der Zeit vor einer strengeren
  // Prüfung (z. B. „Bash(docker:*)“, das auch docker kill freigäbe) dürfen nicht weiter gelten: beim Laden aussortieren.
  const checked = custom.map((group) => ({
    ...group,
    rules: Array.isArray(group.rules) ? group.rules.filter((rule) => customRuleProblem(rule) === null) : group.rules,
  }));
  return { enabled, custom: checked };
}

/** Gruppen, die in einem Projekt zur Verfügung stehen: eingebaute (freigeschaltet) und eigene; „files“ immer. */
export function availableGroups(permissions: ProjectPermissions): PermissionGroup[] {
  const all = [...PERMISSION_GROUPS, ...permissions.custom];
  return permissions.enabled
    ? all.filter(
        (group) =>
          group.id === 'files' || permissions.enabled!.includes(group.id) || permissions.custom.includes(group),
      )
    : all;
}

/** Alle Befehle, die einem Agent in diesem Projekt zugewiesen werden können (je Kategorie). */
export function availableCommands(permissions: ProjectPermissions): Set<string> {
  return new Set(availableGroups(permissions).flatMap((group) => group.rules));
}

/**
 * Legt für Agents ohne eigene Zuweisung (null) die Rollenstandards fest, damit die Oberfläche genau zeigt, was gilt.
 */
export async function materializeAgentCommands(
  pool: { query: <R>(sql: string, values: unknown[]) => Promise<{ rows: R[] }> },
  project: string,
): Promise<void> {
  const agents = (
    await pool.query<{ id: string; role: string }>(
      'SELECT id, role FROM agents WHERE project_slug = $1 AND allowed_commands IS NULL',
      [project],
    )
  ).rows;
  if (!agents.length) return;
  const permissions = await loadProjectPermissions(pool, project);
  for (const agent of agents) {
    await pool.query('UPDATE agents SET allowed_commands = $2 WHERE id = $1 AND allowed_commands IS NULL', [
      agent.id,
      roleDefaultCommands(agent.role, permissions),
    ]);
  }
}

/** Standardrechte einer Rolle, solange dem Agent keine Befehle einzeln zugewiesen sind (null). */
export function roleDefaultCommands(role: string, permissions: ProjectPermissions): string[] {
  if (READ_ONLY_ROLES.has(role)) return [];
  if (NO_FILE_WRITE_ROLES.has(role)) {
    return [...availableCommands(permissions)].filter((rule) => rule !== FILES_CREATE && rule !== FILES_EDIT);
  }
  return TRUSTED_ROLES.has(role) ? [...availableCommands(permissions)] : [FILES_CREATE, FILES_EDIT];
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Hook-Befehl für den Wächter; null, wenn er nicht gestartet werden kann (dann gilt: nichts schreiben, keine Shell). */
export function guardHookCommand(policy: {
  create: boolean;
  edit: boolean;
  scopes: string[];
  shell?: boolean;
}): string | null {
  const typescript = import.meta.url.endsWith('.ts');
  const script = fileURLToPath(new URL(`./agent-guard.${typescript ? 'ts' : 'js'}`, import.meta.url));
  if (!existsSync(script)) return null;
  let loader: string[] = [];
  if (typescript) {
    try {
      // createRequire statt import.meta.resolve: funktioniert auch, wenn tsx das Modul als CommonJS lädt.
      loader = ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href];
    } catch {
      return null;
    }
  }
  const encoded = Buffer.from(JSON.stringify(policy)).toString('base64url');
  // Scheitert der Wächter selbst (Exit ≠ 0/2), sperrt „|| exit 2“ den Zugriff, statt ihn durchzulassen.
  return `${[process.execPath, ...loader, script, encoded].map(shellQuote).join(' ')} || exit 2`;
}

/** Rollen, denen der Admin per Befehl vollen Zugriff geben kann (ohne Wächter). */
export const FULL_ACCESS_ROLES = new Set(['assistant']);

/**
 * Verlangt der Befehl ausdrücklich alle Rechte (`--dangerously-skip-permissions` oder
 * `--permission-mode bypassPermissions`)? Gilt nur für Rollen in FULL_ACCESS_ROLES; alle anderen behalten den Wächter.
 */
export function hasFullAccess(command: readonly string[], role: string): boolean {
  if (!FULL_ACCESS_ROLES.has(role)) return false;
  return command.some(
    (part, index) =>
      part === '--dangerously-skip-permissions' ||
      part === '--permission-mode=bypassPermissions' ||
      (part === '--permission-mode' && command[index + 1] === 'bypassPermissions'),
  );
}

/**
 * Freigaben eines Agents: eigene Zuweisung, sonst der Projektstandard der Rolle – nur Befehle aus freigeschalteten
 * Projektgruppen; lesende Rollen bekommen nichts, Rollen ohne Dateirechte keine Datei-Regeln.
 */
function chosenRules(role: string, permissions: ProjectPermissions, agentCommands: string[] | null): string[] {
  if (READ_ONLY_ROLES.has(role)) return [];
  const noFileWrite = NO_FILE_WRITE_ROLES.has(role);
  const available = availableCommands(permissions);
  return normalizeCommands(agentCommands ?? roleDefaultCommands(role, permissions)).filter(
    (rule) =>
      (available.has(rule) || rule === FILES_CREATE || rule === FILES_EDIT) &&
      !(noFileWrite && (rule === FILES_CREATE || rule === FILES_EDIT)),
  );
}

/**
 * Rechte-Kontext für den eingebauten Ollama-Agent: dieselben Datei- und Befehlsrechte, die bei der Claude-CLI über
 * withAgentPermissions und den Wächter gelten.
 */
export function agentRights(
  role: string,
  permissions: ProjectPermissions,
  agentCommands: string[] | null,
  fileScopes: readonly string[] = [],
): { files: { create: boolean; edit: boolean; scopes: string[] }; commands: string[] } {
  const commands = chosenRules(role, permissions, agentCommands);
  return {
    files: { create: commands.includes(FILES_CREATE), edit: commands.includes(FILES_EDIT), scopes: [...fileScopes] },
    commands,
  };
}

/**
 * Befehlszeile eines Agents mit seinen Rechten (nur Claude-CLI). Ohne eigene Zuweisung (null) gelten die
 * Rollenstandards. Jeder Agent bekommt genau die freigegebenen Befehle; Datei-Werkzeuge nur mit „Dateien anlegen“
 * bzw. „Dateien ändern“, und der Wächter (PreToolUse-Hook) prüft jeden Schreib- und Shell-Zugriff samt Ordnern.
 */
export function withAgentPermissions(
  command: string[],
  role: string,
  permissions: ProjectPermissions,
  agentCommands: string[] | null,
  fileScopes: readonly string[] = [],
  readDirectories: string[] = extraReadDirectories(),
): string[] {
  const [binary, ...rest] = command;
  const isClaude = binary !== undefined && binary.split(sep).pop() === 'claude';
  if (!isClaude) return command;
  // Voller Zugriff nur für den Dashboard-Assistenten und nur, wenn der Admin ihn im Befehl ausdrücklich verlangt:
  // dann weder Wächter noch Sperrlisten – der Assistent arbeitet mit allen Rechten des Workers.
  if (hasFullAccess(command, role)) return command;
  const readOnly = READ_ONLY_ROLES.has(role);
  const noFileWrite = NO_FILE_WRITE_ROLES.has(role);
  const custom = !readOnly && !noFileWrite && rest.some((part) => /^--(?:allowed|disallowed)-?tools$/i.test(part));
  const chosen = chosenRules(role, permissions, agentCommands);
  // Selbst gesetzte Werkzeug-Regeln im Befehl bleiben (Entscheid des Admins); der Wächter prüft trotzdem.
  const policy = readOnly
    ? { create: false, edit: false, scopes: [], shell: false }
    : noFileWrite
      ? { create: false, edit: false, scopes: [] }
      : custom
        ? { create: true, edit: true, scopes: [] }
        : { create: chosen.includes(FILES_CREATE), edit: chosen.includes(FILES_EDIT), scopes: [...fileScopes] };
  const hook = guardHookCommand(policy);
  const blocked = [
    ...(policy.create && hook ? [] : CREATE_TOOLS),
    ...(policy.edit && hook ? [] : EDIT_TOOLS),
    ...(readOnly ? ['MultiEdit'] : []),
    ...(hook && !readOnly ? [] : ['Bash']),
  ];
  const guard = hook
    ? [
        '--settings',
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash',
                hooks: [{ type: 'command', command: hook, timeout: 90 }],
              },
            ],
          },
        }),
      ]
    : [];
  if (custom) return [binary, ...guard, ...(blocked.length ? ['--disallowedTools', blocked.join(',')] : []), ...rest];
  const rules = [...chosen.filter(isToolRule), ...(chosen.includes(SERVICES_COMMAND) ? [servicesRule()] : [])];
  const directories = chosen.includes(LOGS_COMMAND)
    ? readDirectories.flatMap((directory) => ['--add-dir', directory])
    : [];
  return [
    binary,
    ...directories,
    ...guard,
    ...(rules.length ? ['--allowedTools', rules.join(',')] : []),
    ...(blocked.length ? ['--disallowedTools', blocked.join(',')] : []),
    ...rest,
  ];
}
