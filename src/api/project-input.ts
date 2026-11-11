// Prüfung der Eingaben für PATCH /projects/:slug: je Einstellungsgruppe eine Funktion, die Spaltenzuweisungen oder den
// Fehlertext liefert. Die SQL-Anweisung baut src/db/project-repository.ts.
import { encryptSecret } from '../core/secrets.js';
import { parseSandboxMode } from '../core/sandbox.js';
import { REVIEW_MODES } from '../core/status.js';
import { projectFolderError } from '../core/validation.js';
import { isValidWorkingHours, type WorkingHours } from '../core/working-hours.js';
import type { ProjectAssignment } from '../db/project-repository.js';
import { targetsDevLogDatabase } from '../agent/tool-sql.js';
import { isValidGitRemote } from '../runner/git-sync.js';
import { GITHUB_MODES, type GithubMode } from '../runner/github.js';
import { healthUrlError, SERVICE_NAME } from '../runner/production-monitor.js';
import { SPRINT_MODES, type SprintMode } from './sprint-planning.js';
import { parsePreviewSettings } from './visual.js';

type Body = Record<string, unknown>;
/** Zuweisungen der Gruppe oder der Fehlertext für die Antwort (400). */
type Parsed = ProjectAssignment[] | string;

export interface ProjectPatch {
  assignments: ProjectAssignment[];
  /** Gewünschter Modus der GitHub-Brücke; der Handler prüft dazu das Repository. */
  githubMode?: string;
  /** Eine Vorschau-Adresse wird gesetzt: der Workflow braucht dann den visuellen Tester. */
  setsPreviewUrl: boolean;
}

function lines(value: unknown, split: RegExp): string[] | null {
  if (typeof value === 'string')
    return value
      .split(split)
      .map((entry) => entry.trim())
      .filter(Boolean);
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
    return value.map((entry: string) => entry.trim()).filter(Boolean);
  return null;
}

function parseGitRemote(body: Body): Parsed {
  if (body.gitRemote === undefined) return [];
  const remote = typeof body.gitRemote === 'string' ? body.gitRemote.trim() : null;
  if (remote === null || (remote !== '' && !isValidGitRemote(remote))) {
    return 'Ungültige Repository-URL. Erlaubt: https://github.com/<user>/<repo>.git oder git@github.com:<user>/<repo>.git – ohne Zugangsdaten in der URL.';
  }
  return [{ column: 'git_remote', value: remote || null }];
}

function parseDatabaseUrl(body: Body): Parsed {
  if (body.databaseUrl === undefined) return [];
  const url = typeof body.databaseUrl === 'string' ? body.databaseUrl.trim() : null;
  if (url === null || (url !== '' && (!/^postgres(?:ql)?:\/\/\S+$/.test(url) || url.length > 500))) {
    return 'Ungültiger Datenbank-Zugang. Erlaubt: postgresql://user:passwort@host:port/datenbank';
  }
  if (url && targetsDevLogDatabase(url)) return 'Der Zugang darf nicht auf die AIdeation-Datenbank zeigen.';
  return [{ column: 'database_url', value: url ? encryptSecret(url) : null }];
}

function parseRepository(body: Body): Parsed {
  if (body.repository === undefined) return [];
  const folder = typeof body.repository === 'string' ? body.repository.trim() : '';
  return projectFolderError(folder) ?? [{ column: 'repository', value: folder }];
}

/** Definition of Ready/Done: ein Punkt pro Zeile (führende „-“/„*“ entfallen) oder als Liste. */
function parseDefinitions(body: Body): Parsed {
  const sets: ProjectAssignment[] = [];
  for (const [field, column] of [
    ['definitionOfReady', 'definition_of_ready'],
    ['definitionOfDone', 'definition_of_done'],
  ] as const) {
    const raw = body[field];
    if (raw === undefined) continue;
    const items =
      typeof raw === 'string'
        ? raw
            .split('\n')
            .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
            .filter(Boolean)
        : lines(raw, /\n/);
    if (!items || items.length > 20 || items.some((item) => item.length > 300)) {
      return 'Definition of Ready/Done: höchstens 20 Punkte mit je bis zu 300 Zeichen, ein Punkt pro Zeile.';
    }
    sets.push({ column, value: items.length ? items : null });
  }
  return sets;
}

/** Testbefehle (Live schalten) und Testbefehle je Auftrag (Tester-Schritt): ein Befehl pro Zeile. */
function parseTestCommands(body: Body): Parsed {
  const sets: ProjectAssignment[] = [];
  for (const [field, column, label] of [
    ['testCommands', 'test_commands', 'Testbefehle'],
    ['orderTestCommands', 'order_test_commands', 'Testbefehle je Auftrag'],
  ] as const) {
    const raw = body[field];
    if (raw === undefined) continue;
    let commands: string[][] | null = null;
    if (typeof raw === 'string' && raw.trim()) {
      commands = raw
        .trim()
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => line.trim().split(/\s+/));
    } else if (raw !== null && raw !== '') {
      return `${label}: ein Befehl pro Zeile, z. B. „npm test“.`;
    }
    sets.push({ column, value: commands ? JSON.stringify(commands) : null, cast: 'jsonb' });
  }
  return sets;
}

function parseDeployCommands(body: Body): Parsed {
  if (body.deployCommands === undefined) return [];
  const commands = typeof body.deployCommands === 'string' ? lines(body.deployCommands, /\n/) : null;
  if (!commands || commands.length > 10 || commands.some((line) => line.length > 500)) {
    return 'Deploy-Befehle: höchstens 10 Zeilen, ein Befehl pro Zeile.';
  }
  return [
    {
      column: 'deploy_commands',
      value: commands.length ? JSON.stringify(commands.map((line) => line.split(/\s+/))) : null,
      cast: 'jsonb',
    },
  ];
}

function parseReviewSettings(body: Body): Parsed {
  const sets: ProjectAssignment[] = [];
  if (body.reviewMode !== undefined) {
    if (typeof body.reviewMode !== 'string' || !REVIEW_MODES.has(body.reviewMode))
      return 'Review-Freigabe: nie, nur bei Oberflächen-Änderungen oder immer.';
    sets.push({ column: 'review_mode', value: body.reviewMode });
  }
  if (body.reviewCommand !== undefined) {
    const line = typeof body.reviewCommand === 'string' ? body.reviewCommand.trim() : null;
    if (line === null || line.length > 500) return 'Review-Befehl: ein Befehl, höchstens 500 Zeichen.';
    sets.push({ column: 'review_command', value: line ? JSON.stringify(line.split(/\s+/)) : null, cast: 'jsonb' });
  }
  if (body.reviewUrl !== undefined) {
    const url = typeof body.reviewUrl === 'string' ? body.reviewUrl.trim() : null;
    if (url === null || (url && !/^https?:\/\/\S{1,300}$/.test(url)))
      return 'Review-Adresse: leer lassen oder eine http(s)-Adresse angeben.';
    sets.push({ column: 'review_url', value: url || null });
  }
  return sets;
}

function parseTexts(body: Body): Parsed {
  const sets: ProjectAssignment[] = [];
  for (const key of ['description', 'guidelines'] as const) {
    const text = body[key];
    if (text === undefined) continue;
    if (typeof text !== 'string' || text.length > 10_000) {
      return 'Projektbeschreibung und Regeln dürfen höchstens 10000 Zeichen lang sein.';
    }
    sets.push({ column: key, value: text.trim() });
  }
  return sets;
}

function parseSprintSettings(body: Body): Parsed {
  const sets: ProjectAssignment[] = [];
  if (body.sprintMode !== undefined) {
    if (!SPRINT_MODES.includes(body.sprintMode as SprintMode))
      return 'Sprintplanung: manuell, vorschlagen oder Autopilot.';
    sets.push({ column: 'sprint_mode', value: body.sprintMode });
  }
  if (body.sprintCapacityHours !== undefined) {
    const hours = Number(body.sprintCapacityHours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 1000)
      return 'Kapazität: Agent-Stunden über 0 und höchstens 1000.';
    sets.push({ column: 'sprint_capacity_hours', value: hours });
  }
  return sets;
}

/** Arbeitszeiten des Autopiloten immer als Ganzes: Start, Ende und Wochentage. */
function parseWorkingHours(body: Body): Parsed {
  if (body.autopilotStart === undefined && body.autopilotEnd === undefined && body.autopilotDays === undefined)
    return [];
  const hours = { start: body.autopilotStart, end: body.autopilotEnd, days: body.autopilotDays };
  if (
    typeof hours.start !== 'string' ||
    typeof hours.end !== 'string' ||
    !Array.isArray(hours.days) ||
    !isValidWorkingHours(hours as WorkingHours)
  )
    return 'Arbeitszeiten: Start und Ende als HH:MM und mindestens ein Wochentag.';
  return [
    { column: 'autopilot_start', value: hours.start },
    { column: 'autopilot_end', value: hours.end },
    { column: 'autopilot_days', value: hours.days, cast: 'smallint[]' },
  ];
}

/** Prüft Health-URL, Log-Dienste, Ausschlussmuster und Aufbewahrung; liefert Spalten und Werte oder den Fehler. */
export function parseProductionSettings(body: Body): [string, unknown][] | string {
  const sets: [string, unknown][] = [];
  if (body.healthUrl !== undefined) {
    const url = typeof body.healthUrl === 'string' ? body.healthUrl.trim() : body.healthUrl === null ? '' : null;
    if (url === null) return 'Ungültige Health-URL.';
    const error = url ? healthUrlError(url) : null;
    if (error) return error;
    sets.push(['health_url', url || null]);
  }
  if (body.logServices !== undefined) {
    const services = lines(body.logServices, /[\s,]+/);
    if (!services || services.length > 20 || services.some((service) => !SERVICE_NAME.test(service))) {
      return 'Log-Dienste: bis zu 20 Compose-Dienstnamen (Buchstaben, Ziffern, „-“, „_“, „.“), mit Komma getrennt.';
    }
    sets.push(['log_services', [...new Set(services)]]);
  }
  if (body.productionIgnore !== undefined) {
    const patterns = lines(body.productionIgnore, /\r?\n/);
    if (!patterns || patterns.length > 50 || patterns.some((pattern) => pattern.length > 200)) {
      return 'Ausschlussmuster: höchstens 50 Zeilen mit je bis zu 200 Zeichen.';
    }
    sets.push(['production_ignore', patterns]);
  }
  if (body.productionRetentionDays !== undefined) {
    const days = Number(body.productionRetentionDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) return 'Aufbewahrung: 1 bis 365 Tage.';
    sets.push(['production_retention_days', days]);
  }
  return sets;
}

function parseProduction(body: Body): Parsed {
  const production = parseProductionSettings(body);
  return typeof production === 'string' ? production : production.map(([column, value]) => ({ column, value }));
}

/** Vorschau-Adresse ohne Cast, Seiten und Einstellungen als jsonb (Prüfung in visual.ts). */
function parsePreview(body: Body): Parsed {
  const preview = parsePreviewSettings(body);
  if (typeof preview === 'string') return preview;
  return preview.map(([column, value]) =>
    column === 'preview_url' ? { column, value } : { column, value, cast: 'jsonb' as const },
  );
}

/** Ein-/Aus-Schalter des Projekts mit ihrer Fehlermeldung. */
const FLAGS = [
  ['autoBugfix', 'auto_bugfix', 'Automatisches Bugfixing muss ein- oder ausgeschaltet sein.'],
  ['agentWorkspace', 'agent_workspace', 'Eigener Arbeitsordner: ein oder aus.'],
  ['autopilotAutoLive', 'autopilot_auto_live', 'Autopilot schaltet selbst live: ein oder aus.'],
  ['restartAfterSprint', 'restart_after_sprint', 'Neustart nach dem Sprint: ein oder aus.'],
  ['githubRequireApproval', 'github_require_approval', 'Freigabe erforderlich: ein oder aus.'],
] as const;

function parseFlags(body: Body): Parsed {
  const sets: ProjectAssignment[] = [];
  for (const [field, column, message] of FLAGS) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'boolean') return message;
    sets.push({ column, value: body[field] });
  }
  return sets;
}

/** Leer bzw. null = globaler Schalter (DEV_LOG_AGENT_SANDBOX), sonst „off“, „docker“ oder „workbench“ nur für dieses Projekt. */
function parseAgentSandbox(body: Body): Parsed {
  if (body.agentSandbox === undefined) return [];
  const global = body.agentSandbox === null || body.agentSandbox === '';
  const mode = global ? null : parseSandboxMode(body.agentSandbox);
  if (mode === null && !global) return 'Docker-Sandbox: global, aus, docker oder workbench.';
  return [{ column: 'agent_sandbox', value: mode }];
}

/** Neuer Modus der GitHub-Brücke: Anmeldung beim nächsten Worker-Takt neu prüfen. */
function parseGithubMode(body: Body): Parsed {
  if (body.githubMode === undefined) return [];
  if (!GITHUB_MODES.includes(body.githubMode as GithubMode))
    return 'GitHub-Brücke: aus, Issues oder Issues und Pull Request.';
  return [
    { column: 'github_mode', value: body.githubMode },
    { column: 'github_auth_checked_at', value: null },
  ];
}

const GROUPS: ((body: Body) => Parsed)[] = [
  parseGitRemote,
  parseDatabaseUrl,
  parseRepository,
  parseDefinitions,
  parseTestCommands,
  parseDeployCommands,
  parseReviewSettings,
  parseTexts,
  parseSprintSettings,
  parseWorkingHours,
  parseProduction,
  parsePreview,
  parseFlags,
  parseAgentSandbox,
  parseGithubMode,
];

/** Prüft alle Felder des PATCH-Bodys; der erste Fehler gewinnt, ohne Änderung gibt es die Meldung „Keine Änderung“. */
export function parseProjectPatch(body: Body): ProjectPatch | string {
  const assignments: ProjectAssignment[] = [];
  for (const parse of GROUPS) {
    const parsed = parse(body);
    if (typeof parsed === 'string') return parsed;
    assignments.push(...parsed);
  }
  if (!assignments.length) return 'Keine Änderung angegeben.';
  return {
    assignments,
    githubMode: typeof body.githubMode === 'string' ? body.githubMode : undefined,
    setsPreviewUrl: assignments.some(({ column, value }) => column === 'preview_url' && Boolean(value)),
  };
}
