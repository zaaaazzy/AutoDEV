import { logged } from '../core/log.js';
import { validAgentCommands } from './permission-groups.js';
import { agentInProject } from './agent-tasks.js';
import { appendAgentStep, DEFAULT_AGENTS } from '../agent/default-agents.js';
import { seedDefaultActions } from '../agent/default-actions.js';
import { SCOPE_PATTERN } from '../agent/agent-guard.js';
import { materializeAgentCommands } from '../agent/tool-permissions.js';
import {
  RESTRICTED_ROLES,
  SYSTEM_ROLES,
  asCommand,
  loadSystemSettings,
  systemAgentUsage,
  systemAgents,
} from '../agent/system-agents.js';
import type { Response, Router } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import {
  buildUpdate,
  isRecord,
  invalidInput,
  isUuid,
  parseBoolean,
  INVALID,
  parseCommand,
  parseFields,
  parseLongText,
  parseNullableUuid,
  parseOption,
  parseProjectSlug,
  parseTitle,
} from '../core/validation.js';
import { PHASE_SET, PHASE_SQL_ORDER } from '../core/workflow-phases.js';
import { hasRole, type Principal } from './roles.js';
import { STEP_COLUMNS } from './workflow.js';
import { defined } from '../core/defined.js';

const ROLES = new Set([
  'author',
  'developer',
  'tester',
  'visual_tester',
  'reviewer',
  'documenter',
  'bug_reviewer',
  'manual_writer',
  'user_manual_writer',
  'custom',
]);
const PHASES = PHASE_SET;
const AGENT_COLUMNS = `id, project_slug AS "projectSlug", name, role, phase, position, instructions, enabled, command,
  allowed_commands AS "allowedCommands", file_scope AS "fileScope", handoff_to AS "handoffTo"`;
const AGENT_FIELDS = {
  name: { column: 'name', parse: parseTitle(80) },
  role: { column: 'role', parse: parseOption(ROLES) },
  phase: { column: 'phase', parse: parseOption(PHASES) },
  instructions: { column: 'instructions', parse: parseLongText },
  enabled: { column: 'enabled', parse: parseBoolean },
  command: { column: 'command', parse: parseCommand },
  fileScope: { column: 'file_scope', parse: parseFileScope },
  handoffTo: { column: 'handoff_to', parse: parseNullableUuid },
};

/** Felder, die nur Administration setzen darf: command läuft als Prozess auf dem Worker, role steuert den Ablauf. */
const ADMIN_COLUMNS = new Set(['command', 'role']);
const ADMIN_ONLY = 'Befehl (command) und Rolle eines Agents darf nur die Administration ändern.';

/**
 * Gemeinsame Schreibprüfung für command und role (POST und PATCH). Ohne Admin-Rolle (auch ohne Benutzer) ist nur
 * erlaubt, was exakt dem Bestand entspricht (beim Anlegen: kein Befehl, Rolle „custom“). Gibt die Felder ohne die
 * unveränderten Admin-Felder zurück, damit nichts geschrieben wird, oder null = verboten (403).
 */
export function adminFieldsCheck(
  principal: Principal | undefined,
  fields: { column: string; value: unknown }[],
  current: { command: unknown; role: unknown },
): { column: string; value: unknown }[] | null {
  if (principal && hasRole(principal, 'admin')) return fields;
  const stored: Record<string, unknown> = current;
  const changed = fields.some(
    (field) =>
      ADMIN_COLUMNS.has(field.column) && JSON.stringify(field.value) !== JSON.stringify(stored[field.column] ?? null),
  );
  return changed ? null : fields.filter((field) => !ADMIN_COLUMNS.has(field.column));
}

/*
 * Eine Quelle für den Ablauf: Hat ein Projekt Workflow-Schritte, führt der Worker nur diese aus (loadWorkflow).
 * Phase und Position am Agent zählen dann nicht mehr; jede Änderung daran wird deshalb in seine Schritte übernommen.
 */

/** Phasenwechsel am Agent: seine Schritte in anderen Phasen wechseln mit, jeweils ans Ende der neuen Phase. */
async function moveAgentSteps(pool: Pool, agentId: string, phase: string): Promise<void> {
  await pool.query(
    `UPDATE workflow_steps s
        SET phase = $2,
            position = COALESCE((SELECT MAX(x.position) FROM workflow_steps x
                                  WHERE x.project_slug = s.project_slug AND x.phase = $2), 0) + m.ord
       FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY position, created_at) AS ord
               FROM workflow_steps WHERE agent_id = $1 AND phase <> $2) m
      WHERE s.id = m.id`,
    [agentId, phase],
  );
}

/** Erlaubte Ordner für Dateirechte: relativ zum Projekt, ohne „..“, höchstens 20; leer = ganzes Projekt. */
function parseFileScope(value: unknown): string[] | typeof INVALID {
  const raw: unknown = typeof value === 'string' ? value.split(/[\n,]/) : value;
  if (!Array.isArray(raw) || !raw.every((entry) => typeof entry === 'string')) return INVALID;
  const scopes = [
    ...new Set((raw as string[]).map((entry) => entry.trim().replace(/^\.\//, '').replace(/\/+$/, ''))),
  ].filter(Boolean);
  return scopes.length <= 20 && scopes.every((scope) => scope.length <= 200 && SCOPE_PATTERN.test(scope))
    ? scopes
    : INVALID;
}

export function registerAgentRoutes(app: Router, pool: Pool): void {
  const principalOf = (response: Response) => response.locals.principal as Principal | undefined;
  app.get('/system-agents', access({ tenant: 'global' }), async (_request, response) => {
    const row = (await pool.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'system_agents'`))
      .rows[0];
    const models = (await pool.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'ollama_models'`))
      .rows[0];
    // Neue Rollen erscheinen sofort, auch wenn der Worker noch die ältere Liste veröffentlicht hat.
    const published = (row ? JSON.parse(row.value) : []) as { role: string; model: string }[];
    const agents = systemAgents().map((agent) => published.find((item) => item.role === agent.role) ?? agent);
    const settings = await loadSystemSettings(pool);
    const fallback = await publishedFallback();
    response.json({
      agents: agents.map((agent) => {
        const model = settings.get(agent.role)?.model ?? agent.model;
        return {
          ...agent,
          model,
          command: settings.get(agent.role)?.command ?? null,
          restricted: (RESTRICTED_ROLES as readonly string[]).includes(agent.role),
          allowTools: settings.get(agent.role)?.allowTools ?? false,
          // Dieselbe Auswahl wie der Lauf (runAuthorAgent bzw. Schnellschätzung).
          usage: systemAgentUsage(agent.role, settings.get(agent.role), fallback, model),
        };
      }),
      models: models ? JSON.parse(models.value) : [],
    });
  });

  /** Vom Worker veröffentlichter Ersatzbefehl (DEV_LOG_AGENT_COMMAND, nur Programmname). */
  const publishedFallback = async (): Promise<string[] | null> => {
    const row = (
      await pool.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'agent_fallback_command'`)
    ).rows[0];
    return row ? asCommand(JSON.parse(row.value)) : null;
  };

  app.put('/system-agents/:role', access({ role: 'admin', tenant: 'admin' }), async (request, response) => {
    const role = SYSTEM_ROLES.find(([, , value]) => value === request.params.role)?.[2];
    const body = (request.body ?? {}) as { model?: unknown; command?: unknown; allowTools?: unknown };
    const model = body.model;
    const allowTools = body.allowTools;
    const command = body.command === undefined ? undefined : parseCommand(body.command);
    if (
      !role ||
      (model === undefined && command === undefined && allowTools === undefined) ||
      (allowTools !== undefined &&
        (typeof allowTools !== 'boolean' || !(RESTRICTED_ROLES as readonly string[]).includes(role))) ||
      (model !== undefined && (typeof model !== 'string' || model.length > 200 || !/^[\w./:@+-]*$/.test(model))) ||
      command === INVALID
    ) {
      response.status(400).json({ message: 'Ungültige Rolle, ungültiges Modell oder ungültiger Befehl.' });
      return;
    }
    // Only the given fields change; an empty model resets the choice to the worker default.
    const saved = await pool.query<{ model: string | null; command: string[] | null; allowTools: boolean }>(
      `INSERT INTO system_agent_settings (role, model, command, allow_tools)
       VALUES ($1, NULLIF($2, ''), $3::jsonb, COALESCE($4, FALSE))
       ON CONFLICT (role) DO UPDATE SET
         model = CASE WHEN $5 THEN EXCLUDED.model ELSE system_agent_settings.model END,
         command = CASE WHEN $6 THEN EXCLUDED.command ELSE system_agent_settings.command END,
         allow_tools = COALESCE($4, system_agent_settings.allow_tools)
       RETURNING model, command, allow_tools AS "allowTools"`,
      [
        role,
        model ?? null,
        command ? JSON.stringify(command) : null,
        allowTools ?? null,
        model !== undefined,
        command !== undefined,
      ],
    );
    const row = defined(saved.rows[0]);
    const setting = { model: row.model, command: asCommand(row.command), allowTools: row.allowTools };
    const localModel = row.model ?? systemAgents().find((agent) => agent.role === role)?.model ?? '';
    // Neue Anzeige „verwendet“ gleich nach dem Speichern, ohne auf den Worker zu warten.
    response.json({ role, ...row, usage: systemAgentUsage(role, setting, await publishedFallback(), localModel) });
  });

  // Workflow order: phase (pre, while, after), then position.
  app.get('/projects/:slug/agents', access({ tenant: 'project' }), async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Ungültiges Projekt.' });
      return;
    }
    // Mit Workflow-Schritten zeigt der Agent Phase und Position seines ersten Schritts – so, wie der Worker ihn ausführt.
    const result = await pool.query(
      `SELECT a.id, a.project_slug AS "projectSlug", a.name, a.role, COALESCE(s.phase, a.phase) AS phase,
              COALESCE(s.position, a.position) AS position, a.instructions, a.enabled, a.command,
              a.allowed_commands AS "allowedCommands", a.file_scope AS "fileScope", a.handoff_to AS "handoffTo"
         FROM agents a
         LEFT JOIN LATERAL (
           SELECT phase, position FROM workflow_steps WHERE agent_id = a.id
            ORDER BY ${PHASE_SQL_ORDER}, position, created_at LIMIT 1
         ) s ON TRUE
        WHERE a.project_slug = $1
        ORDER BY ${PHASE_SQL_ORDER.replace('CASE phase', 'CASE COALESCE(s.phase, a.phase)')},
                 COALESCE(s.position, a.position), a.created_at`,
      [slug],
    );
    response.json({ agents: result.rows });
  });

  app.post('/projects/:slug/agents', access({ role: 'agents', tenant: 'project' }), async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    const fields = parseFields(request.body, AGENT_FIELDS);
    const values = new Map((fields ?? []).map((field) => [field.column, field.value]));
    if (!slug || !fields || !values.get('name') || !values.get('phase')) {
      response
        .status(400)
        .json(slug ? invalidInput(request.body, AGENT_FIELDS, ['name', 'phase']) : { message: 'Ungültiges Projekt.' });
      return;
    }
    if (!adminFieldsCheck(principalOf(response), fields, { command: null, role: 'custom' })) {
      return void response.status(403).json({ message: ADMIN_ONLY });
    }
    // Rechte: jeder Befehl wird einzeln gesetzt, nur aus Kategorien dieses Projekts (Mandantentrennung).
    const requested = isRecord(request.body) ? request.body.allowedCommands : undefined;
    // null = Projektstandard der Rolle (z. B. beim Einsetzen eines bestehenden Agents an weiterer Stelle).
    const groups =
      requested === null ? null : await validAgentCommands(pool, slug, requested === undefined ? [] : requested);
    if (typeof groups === 'string') return void response.status(400).json({ message: groups });
    const result = await pool.query(
      `INSERT INTO agents (project_slug, name, role, phase, position, instructions, enabled, command, allowed_commands,
         file_scope)
       SELECT $1, $2, COALESCE($3, 'custom'), $4, COALESCE(MAX(position), 0) + 1, $5, COALESCE($6, TRUE), $7, $8,
         COALESCE($9::text[], '{}')
         FROM agents WHERE project_slug = $1 AND phase = $4
       RETURNING ${AGENT_COLUMNS}`,
      [
        slug,
        values.get('name'),
        values.get('role') ?? null,
        values.get('phase'),
        values.get('instructions') ?? '',
        values.get('enabled') ?? null,
        values.get('command') ?? null,
        groups,
        values.get('file_scope') ?? null,
      ],
    );
    const agent = result.rows[0] as { id: string } | undefined;
    const step = agent
      ? await appendAgentStep(pool, slug, agent.id, values.get('phase') as string, STEP_COLUMNS)
      : undefined;
    response.status(201).json({ agent, step: step ?? null });
  });

  app.post(
    '/projects/:slug/agents/defaults',
    access({ role: 'agents', tenant: 'project' }),
    async (request, response) => {
      const slug = parseProjectSlug(request.params.slug ?? '');
      if (!slug) {
        response.status(400).json({ message: 'Ungültiges Projekt.' });
        return;
      }
      const result = await pool.query(
        `INSERT INTO agents (project_slug, name, role, phase, position, instructions)
       SELECT $1, d.name, d.role, d.phase, d.ord, d.instructions
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) WITH ORDINALITY AS d(name, role, phase, instructions, ord)
        WHERE NOT EXISTS (SELECT 1 FROM agents WHERE project_slug = $1)
       RETURNING ${AGENT_COLUMNS}`,
        [
          slug,
          DEFAULT_AGENTS.map((agent) => agent.name),
          DEFAULT_AGENTS.map((agent) => agent.role),
          DEFAULT_AGENTS.map((agent) => agent.phase),
          DEFAULT_AGENTS.map((agent) => agent.instructions),
        ],
      );
      if (result.rows.length) {
        await seedDefaultActions(pool, slug).catch(logged('agents'));
        await materializeAgentCommands(pool, slug).catch(logged('agents'));
      }
      // Hat das Projekt schon Workflow-Schritte, kommen die neuen Standard-Agents dort an ihre Stelle.
      await pool.query(
        `INSERT INTO workflow_steps (project_slug, phase, position, agent_id)
       SELECT a.project_slug, a.phase, a.position, a.id FROM agents a
        WHERE a.project_slug = $1 AND a.id = ANY($2::uuid[])
          AND EXISTS (SELECT 1 FROM workflow_steps WHERE project_slug = $1)`,
        [slug, result.rows.map((row: { id: string }) => row.id)],
      );
      response.status(result.rows.length ? 201 : 200).json({ agents: result.rows });
    },
  );

  app.post('/projects/:slug/agents/order', access({ role: 'agents', tenant: 'project' }), async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    const body = request.body as unknown;
    if (
      !slug ||
      !isRecord(body) ||
      typeof body.phase !== 'string' ||
      !PHASES.has(body.phase) ||
      !Array.isArray(body.ids) ||
      body.ids.length > 100 ||
      !body.ids.every(isUuid)
    ) {
      response.status(400).json({ message: 'Ungültige Reihenfolge der Agents.' });
      return;
    }
    await pool.query(
      // Reihenfolge einer Spalte im Workflow-Board; Agents aus anderen Spalten wechseln dabei in diese Phase.
      `UPDATE agents a SET position = o.ord, phase = $2, updated_at = NOW()
         FROM unnest($3::uuid[]) WITH ORDINALITY AS o(id, ord)
        WHERE a.id = o.id AND a.project_slug = $1`,
      [slug, body.phase, body.ids],
    );
    // Dieselbe Reihenfolge in den Workflow-Schritten der Agents – sonst führte der Worker die alte aus.
    await pool.query(
      `UPDATE workflow_steps s SET position = o.ord, phase = $2
         FROM unnest($3::uuid[]) WITH ORDINALITY AS o(id, ord)
        WHERE s.agent_id = o.id AND s.project_slug = $1`,
      [slug, body.phase, body.ids],
    );
    response.status(204).end();
  });

  app.patch('/agents/:id', access({ role: 'agents', tenant: 'agents' }), async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Nicht gefunden.' });
      return;
    }
    const requested = isRecord(request.body) ? request.body.allowedCommands : undefined;
    const fields = parseFields(request.body, AGENT_FIELDS) ?? (requested !== undefined ? [] : null);
    if (!fields) {
      response.status(400).json(invalidInput(request.body, AGENT_FIELDS));
      return;
    }
    let allowed = fields;
    const handoffTo = fields.find((field) => field.column === 'handoff_to')?.value as string | null | undefined;
    if (requested !== undefined || handoffTo || fields.some((field) => ADMIN_COLUMNS.has(field.column))) {
      const current = (
        await pool.query<{ slug: string; command: string[] | null; role: string }>(
          'SELECT project_slug AS slug, command, role FROM agents WHERE id = $1',
          [request.params.id],
        )
      ).rows[0];
      if (!current) return void response.status(404).json({ message: 'Agent nicht gefunden.' });
      const checked = adminFieldsCheck(principalOf(response), fields, current);
      if (!checked) return void response.status(403).json({ message: ADMIN_ONLY });
      allowed = checked;
      // Nachrichten gehen nur an Agents desselben Projekts (Mandantentrennung); null = kein fester Empfänger.
      if (handoffTo && !(await agentInProject(pool, handoffTo, current.slug))) {
        return void response.status(400).json({ message: 'Der Empfänger gehört nicht zu diesem Projekt.' });
      }
      if (requested !== undefined) {
        const commands = await validAgentCommands(pool, current.slug, requested);
        if (typeof commands === 'string') return void response.status(400).json({ message: commands });
        allowed.push({ column: 'allowed_commands', value: commands });
      }
    }
    // Nur unveränderte command/role-Felder eines Nicht-Admins: nichts zu schreiben, aktueller Stand zurück.
    const update = buildUpdate('agents', request.params.id, allowed, AGENT_COLUMNS);
    const result = allowed.length
      ? await pool.query(update.sql, update.values)
      : await pool.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1`, [request.params.id]);
    if (!result.rows[0]) {
      response.status(404).json({ message: 'Agent nicht gefunden.' });
      return;
    }
    // Phasenwechsel gilt auch für die Workflow-Schritte des Agents (die führt der Worker aus).
    const phase = allowed.find((field) => field.column === 'phase')?.value;
    if (typeof phase === 'string') await moveAgentSteps(pool, request.params.id, phase);
    response.json({ agent: result.rows[0] });
  });

  app.delete('/agents/:id', access({ role: 'agents', tenant: 'agents' }), async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Nicht gefunden.' });
      return;
    }
    const result = await pool.query('DELETE FROM agents WHERE id = $1 RETURNING id', [request.params.id]);
    if (!result.rows[0]) {
      response.status(404).json({ message: 'Agent nicht gefunden.' });
      return;
    }
    response.status(204).end();
  });
}
