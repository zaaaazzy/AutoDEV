import { logged } from '../core/log.js';
import { PHASE_SQL_ORDER } from '../core/workflow-phases.js';
import type { Pool } from 'pg';
import { loadSystemSettings, systemAgents, systemCommand } from '../agent/system-agents.js';
import { productionGuide } from './production-snippets.js';
import { ROLE_INFO, type Role } from './roles.js';
import { workflowDocs } from './workflow-docs.js';
import { defined } from '../core/defined.js';

/**
 * Automatisch erzeugte, schreibgeschützte Dokumente für die Dokumentation: Testberichte (aus test:full),
 * Agent-Einstellungen und Benutzerübersicht. Sie entstehen beim Laden und sind damit immer aktuell.
 */
export interface GeneratedDoc {
  id: string;
  projectSlug: string;
  kind: 'test' | 'settings' | 'workflow';
  title: string;
  content: string;
  developmentId: null;
  sprintId: null;
  createdAt: string;
  updatedAt: string;
}

const PHASE_LABEL: Record<string, string> = {
  pre_sprint: 'Vor dem Sprint',
  pre_task: 'Vor dem Auftrag',
  while_task: 'Während',
  after_task: 'Danach',
  on_rejected: 'Bei abgelehnt',
  on_done: 'Bei abgeschlossen',
};
const ROLE_LABEL: Record<string, string> = {
  author: 'Auftragsautor',
  developer: 'Entwickler',
  tester: 'Tester',
  reviewer: 'Reviewer',
  documenter: 'Dokumentierer',
  bug_reviewer: 'Bug-Wächter',
  manual_writer: 'Handbuch-Autor',
  user_manual_writer: 'Benutzerhandbuch-Autor',
  troubleshooter: 'Problemlöser',
  custom: 'Eigener Agent',
};

const cell = (value: string): string => value.replace(/\|/g, '/').replace(/\s+/g, ' ').trim() || '–';
const date = (value: Date | string | null): string =>
  value ? new Date(value).toLocaleString('de-CH', { dateStyle: 'medium', timeStyle: 'short' }) : 'nie';

/** Modell bzw. Befehl eines Agents in Kurzform, z. B. „Claude · opus“ oder „Lokal (Ollama)“. */
function modelOf(command: string[] | null): string {
  if (!command?.length) return 'Lokal (Ollama)';
  const model = command[command.indexOf('--model') + 1];
  return command[0] === 'claude'
    ? `Claude${command.includes('--model') && model ? ` · ${model}` : ''}`
    : defined(command[0]);
}

async function testReports(pool: Pool, slug: string): Promise<GeneratedDoc[]> {
  const runs = await pool.query<{
    id: string;
    report: string;
    startedAt: Date;
    completedAt: Date | null;
    status: string;
  }>(
    `SELECT id, report, status, started_at AS "startedAt", completed_at AS "completedAt"
       FROM test_runs
      WHERE project_slug = $1 AND report IS NOT NULL
      ORDER BY started_at DESC
      LIMIT 30`,
    [slug],
  );
  return runs.rows.map((run) => ({
    id: run.id,
    projectSlug: slug,
    kind: 'test',
    title: `Testbericht ${date(run.startedAt)}${run.status === 'passed' ? '' : run.status === 'failed' ? ' – mit Befunden' : ' – läuft'}`,
    content: run.report,
    developmentId: null,
    sprintId: null,
    createdAt: new Date(run.startedAt).toISOString(),
    updatedAt: new Date(run.completedAt ?? run.startedAt).toISOString(),
  }));
}

async function agentSettings(pool: Pool, slug: string): Promise<GeneratedDoc> {
  const agents = await pool.query<{
    name: string;
    role: string;
    phase: string;
    position: number;
    enabled: boolean;
    instructions: string;
    command: string[] | null;
    allowedCommands: string[] | null;
    updatedAt: Date;
  }>(
    `SELECT name, role, phase, position, enabled, instructions, command, allowed_commands AS "allowedCommands",
            updated_at AS "updatedAt"
       FROM agents WHERE project_slug = $1
      ORDER BY ${PHASE_SQL_ORDER}, position, created_at`,
    [slug],
  );
  const rows = agents.rows;
  // Im Dashboard gewählte Modelle der Systemagents gehen der Umgebung vor (wie beim Worker)
  const chosen = await loadSystemSettings(pool);
  const systemModel = (role: string, fallback: string) => chosen.get(role)?.model || fallback;
  const lines = [
    '# Agent-Einstellungen',
    '',
    `Automatisch erzeugt aus den Einstellungen unter Agents, Stand ${date(new Date())}. Ändern unter [Agents](#agents).`,
    '',
    '## Workflow',
    '',
    '| Reihenfolge | Agent | Rolle | Phase | Modell | Status |',
    '|---|---|---|---|---|---|',
    ...rows.map(
      (agent, index) =>
        `| ${index + 1} | ${cell(agent.name)} | ${ROLE_LABEL[agent.role] ?? agent.role} | ${PHASE_LABEL[agent.phase] ?? agent.phase} | ${cell(modelOf(agent.command))} | ${agent.enabled ? 'Aktiv' : 'Inaktiv'} |`,
    ),
    '',
    '## Systemagents',
    '',
    '| Agent | Aufgabe | Modell |',
    '|---|---|---|',
    ...(await Promise.all(
      systemAgents().map(async (agent) => {
        const command = await systemCommand(pool, agent.role);
        const model = command ? modelOf(command) : `Lokal (Ollama ${systemModel(agent.role, agent.model)})`;
        return `| ${agent.name} | ${cell(agent.description)} | ${cell(model)} |`;
      }),
    )),
    '',
    '## Anweisungen und Befehle',
  ];
  for (const agent of rows) {
    lines.push(
      '',
      `### ${agent.name}`,
      '',
      `- Rolle: ${ROLE_LABEL[agent.role] ?? agent.role} · Phase: ${PHASE_LABEL[agent.phase] ?? agent.phase} · ${agent.enabled ? 'aktiv' : 'inaktiv'}`,
      `- Befehl: ${agent.command?.length ? `\`${agent.command.join(' ')}\`` : 'eingebauter Agent (lokales Modell)'}`,
      `- Erlaubte Befehle: ${agent.allowedCommands?.length ? agent.allowedCommands.map((command) => `\`${command}\``).join(', ') : 'Standard der Rolle'}`,
      `- Geändert: ${date(agent.updatedAt)}`,
      '',
      ...(agent.instructions.trim()
        ? agent.instructions
            .trim()
            .split('\n')
            .map((line) => `> ${line}`)
        : ['_Keine Anweisung._']),
    );
  }
  const latest = rows.reduce<Date | null>(
    (max, agent) => (!max || agent.updatedAt > max ? agent.updatedAt : max),
    null,
  );
  return settingsDoc(slug, 'agents', 'Agent-Einstellungen', lines.join('\n'), latest);
}

async function userOverview(pool: Pool, slug: string): Promise<GeneratedDoc> {
  const users = await pool.query<{
    username: string;
    displayName: string;
    roles: Role[];
    active: boolean;
    totp: boolean;
    lastLoginAt: Date | null;
    member: boolean;
    updatedAt: Date;
  }>(
    `SELECT u.username, u.display_name AS "displayName", u.roles, u.active, u.totp_secret IS NOT NULL AS totp,
            u.last_login_at AS "lastLoginAt", u.updated_at AS "updatedAt",
            EXISTS (SELECT 1 FROM project_members m WHERE m.user_id = u.id AND m.project_slug = $1) AS member
       FROM users u
      ORDER BY u.active DESC, lower(u.display_name), lower(u.username)`,
    [slug],
  );
  const access = (user: { roles: Role[]; member: boolean }) =>
    user.roles.includes('admin') ? 'alle Projekte' : user.member ? 'ja' : 'nein';
  const lines = [
    '# Benutzerübersicht',
    '',
    `Automatisch erzeugt, Stand ${date(new Date())}. Ändern unter [Einstellungen](#settings) → Benutzer & Rollen.`,
    '',
    '| Name | Benutzer | Rollen | Zugriff auf dieses Projekt | Zwei-Faktor | Zuletzt angemeldet | Status |',
    '|---|---|---|---|---|---|---|',
    '| Systemadministrator | aus der .env | alle Rechte | alle Projekte | – | – | Aktiv |',
    ...users.rows.map(
      (user) =>
        `| ${cell(user.displayName || user.username)} | ${cell(user.username)} | ${cell(user.roles.map((role) => ROLE_INFO[role]?.label ?? role).join(', ') || 'nur lesen')} | ${access(user)} | ${user.totp ? 'ja' : 'nein'} | ${date(user.lastLoginAt)} | ${user.active ? 'Aktiv' : 'Gesperrt'} |`,
    ),
    '',
    '## Rollen',
    '',
    '| Rolle | Erlaubt |',
    '|---|---|',
    ...Object.values(ROLE_INFO).map((role) => `| ${role.label} | ${cell(role.description)} |`),
    '',
    'Lesen dürfen alle Benutzer mit Zugriff auf das Projekt.',
  ];
  const latest = users.rows.reduce<Date | null>(
    (max, user) => (!max || user.updatedAt > max ? user.updatedAt : max),
    null,
  );
  return settingsDoc(slug, 'users', 'Benutzerübersicht', lines.join('\n'), latest);
}

function settingsDoc(slug: string, key: string, title: string, content: string, updated: Date | null): GeneratedDoc {
  const at = (updated ?? new Date()).toISOString();
  return {
    id: `einstellungen-${key}`,
    projectSlug: slug,
    kind: 'settings',
    title,
    content,
    developmentId: null,
    sprintId: null,
    createdAt: at,
    updatedAt: at,
  };
}

/** Alle erzeugten Dokumente eines Projekts; die Benutzerübersicht nur für Administratoren. */
export async function generatedDocs(
  pool: Pool,
  slug: string,
  isAdmin: boolean,
  baseUrl = 'http://localhost:3100',
): Promise<GeneratedDoc[]> {
  const [reports, agents, users, workflow] = await Promise.all([
    testReports(pool, slug),
    agentSettings(pool, slug),
    isAdmin ? userOverview(pool, slug) : Promise.resolve(null),
    workflowDocs(slug).catch(logged('generated-docs', [])),
  ]);
  // Anleitung mit kopierbaren Snippets für Browser und Node (Produktions-Rückkanal).
  const production = settingsDoc(
    slug,
    'betrieb',
    'Betrieb: Fehler an Dev Log melden',
    productionGuide(baseUrl, slug),
    null,
  );
  return [...workflow, ...reports, agents, production, ...(users ? [users] : [])];
}
