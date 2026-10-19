import { validAgentCommands } from './permission-groups.js';
import { seedDefaultActions } from './agent-tasks.js';
import { SCOPE_PATTERN } from '../agent/agent-guard.js';
import { materializeAgentCommands } from '../agent/tool-permissions.js';
import { SYSTEM_ROLES, systemAgents } from '../agent/system-agents.js';
import type { Express } from 'express';
import type { Pool } from 'pg';
import {
  buildUpdate,
  isRecord,
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

const ROLES = new Set([
  'author',
  'developer',
  'tester',
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

export const DEFAULT_AGENTS = [
  {
    name: 'Auftragsautor',
    role: 'author',
    phase: 'pre_task',
    instructions:
      'Beschreibt den Auftrag aus der Idee: Ziel, Anforderungen, Akzeptanzkriterien, betroffene Dateien. Diagramme (Mermaid) und ein ERM sind erwünscht, wenn sie das Verständnis verbessern.',
  },
  {
    name: 'Bug-Wächter',
    role: 'bug_reviewer',
    phase: 'pre_task',
    instructions:
      'Prüft alle bisherigen Bugs, nennt die im selben Kontext wie der Auftrag und beschreibt, was dabei nicht wiederholt werden darf. Das Ergebnis erscheint beim Auftrag unter Risiken.',
  },
  {
    name: 'Entwickler',
    role: 'developer',
    phase: 'while_task',
    instructions:
      'Setzt den Auftrag um. Nutzt Projektbeschreibung, Leitlinien, Risiken und alle Vorarbeiten. Hält die Leitlinien ein und dokumentiert, was geändert wurde.',
  },
  {
    name: 'Tester',
    role: 'tester',
    phase: 'after_task',
    instructions:
      'Entwickelt anhand der Angaben des Entwicklers die Tests, misst die Testabdeckung je Bereich, ergänzt Tests für Lücken, führt Build und Tests aus und meldet Fehler als Bug.',
  },
  {
    name: 'Reviewer',
    role: 'reviewer',
    phase: 'after_task',
    instructions:
      'Prüft die Änderungen des Auftrags wie ein Code-Review vor dem Merge: Akzeptanzkriterien, Leitlinien, Lesbarkeit, Sicherheit und Tests. Gibt frei oder fordert Änderungen an.',
  },
  {
    name: 'Dokumentierer',
    role: 'documenter',
    phase: 'after_task',
    instructions:
      'Dokumentiert das Ergebnis des Auftrags: Was wurde umgesetzt, welche Dateien wurden geändert, worauf ist zu achten.',
  },
  {
    name: 'Handbuch-Autor',
    role: 'manual_writer',
    phase: 'after_task',
    instructions:
      'Pflegt das technische Handbuch von A bis Z: Zweck, Architektur, Konfiguration, Betrieb. Gibt das vollständige, aktualisierte Handbuch in Markdown aus.',
  },
  {
    name: 'Benutzerhandbuch-Autor',
    role: 'user_manual_writer',
    phase: 'after_task',
    instructions:
      'Pflegt das Benutzerhandbuch für Anwender: Bedienung Schritt für Schritt, ohne Technik-Jargon. Gibt das vollständige, aktualisierte Benutzerhandbuch in Markdown aus.',
  },
] as const;

/** Seeds the default workflow once per project; later deletions are respected. */
export async function ensureDefaultAgents(pool: Pool, slug: string): Promise<void> {
  await pool.query(
    `WITH claim AS (
       UPDATE projects SET agents_seeded = TRUE WHERE slug = $1 AND NOT agents_seeded RETURNING slug
     )
     INSERT INTO agents (project_slug, name, role, phase, position, instructions)
     SELECT claim.slug, d.name, d.role, d.phase, d.ord, d.instructions
       FROM claim,
            unnest($2::text[], $3::text[], $4::text[], $5::text[]) WITH ORDINALITY AS d(name, role, phase, instructions, ord)
      WHERE NOT EXISTS (SELECT 1 FROM agents WHERE project_slug = claim.slug)`,
    [
      slug,
      DEFAULT_AGENTS.map((agent) => agent.name),
      DEFAULT_AGENTS.map((agent) => agent.role),
      DEFAULT_AGENTS.map((agent) => agent.phase),
      DEFAULT_AGENTS.map((agent) => agent.instructions),
    ],
  );
  // Neue Projekte bekommen mit den Agents auch die Standard-Aktionen des Testers.
  await seedDefaultActions(pool, slug).catch(() => undefined);
  await materializeAgentCommands(pool, slug).catch(() => undefined);
}

export function registerAgentRoutes(app: Express, pool: Pool): void {
  app.get('/api/system-agents', async (_request, response) => {
    const row = (await pool.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'system_agents'`))
      .rows[0];
    const models = (await pool.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'ollama_models'`))
      .rows[0];
    const chosen = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM app_settings WHERE key LIKE 'model:%'`,
    );
    // Neue Rollen erscheinen sofort, auch wenn der Worker noch die ältere Liste veröffentlicht hat.
    const published = (row ? JSON.parse(row.value) : []) as { role: string; model: string }[];
    const agents = systemAgents().map((agent) => published.find((item) => item.role === agent.role) ?? agent);
    const commands = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM app_settings WHERE key LIKE 'command:%'`,
    );
    response.json({
      agents: agents.map((agent) => ({
        ...agent,
        model: chosen.rows.find((item) => item.key === `model:${agent.role}`)?.value ?? agent.model,
        command: JSON.parse(commands.rows.find((item) => item.key === `command:${agent.role}`)?.value ?? 'null'),
      })),
      models: models ? JSON.parse(models.value) : [],
    });
  });

  app.put('/api/system-agents/:role', async (request, response) => {
    const role = SYSTEM_ROLES.find(([, , value]) => value === request.params.role)?.[2];
    const body = (request.body ?? {}) as { model?: unknown; command?: unknown };
    const model = body.model ?? '';
    const command = body.command === undefined ? undefined : parseCommand(body.command);
    if (
      !role ||
      typeof model !== 'string' ||
      model.length > 200 ||
      !/^[\w./:@+-]*$/.test(model) ||
      command === INVALID
    ) {
      response.status(400).json({ message: 'Ungültige Rolle, ungültiges Modell oder ungültiger Befehl.' });
      return;
    }
    if (command !== undefined) {
      if (command === null) await pool.query(`DELETE FROM app_settings WHERE key = $1`, [`command:${role}`]);
      else
        await pool.query(
          `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [`command:${role}`, JSON.stringify(command)],
        );
    }
    if (!model && command !== undefined) {
      response.json({ role, command });
      return;
    }
    if (model) {
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [`model:${role}`, model],
      );
    } else {
      await pool.query(`DELETE FROM app_settings WHERE key = $1`, [`model:${role}`]);
    }
    response.json({ role, model });
  });

  // Workflow order: phase (pre, while, after), then position.
  app.get('/api/projects/:slug/agents', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Invalid project slug.' });
      return;
    }
    const result = await pool.query(
      `SELECT ${AGENT_COLUMNS} FROM agents WHERE project_slug = $1
        ORDER BY ${PHASE_SQL_ORDER}, position, created_at`,
      [slug],
    );
    response.json({ agents: result.rows });
  });

  app.post('/api/projects/:slug/agents', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    const fields = parseFields(request.body, AGENT_FIELDS);
    const values = new Map((fields ?? []).map((field) => [field.column, field.value]));
    if (!slug || !fields || !values.get('name') || !values.get('phase')) {
      response.status(400).json({ message: 'Invalid agent.' });
      return;
    }
    // Rechte: jeder Befehl wird einzeln gesetzt, nur aus Kategorien dieses Projekts (Mandantentrennung).
    const requested = isRecord(request.body) ? request.body.allowedCommands : undefined;
    const groups = await validAgentCommands(pool, slug, requested === undefined ? [] : requested);
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
    response.status(201).json({ agent: result.rows[0] });
  });

  app.post('/api/projects/:slug/agents/defaults', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Invalid project slug.' });
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
      await seedDefaultActions(pool, slug).catch(() => undefined);
      await materializeAgentCommands(pool, slug).catch(() => undefined);
    }
    response.status(result.rows.length ? 201 : 200).json({ agents: result.rows });
  });

  app.post('/api/projects/:slug/agents/order', async (request, response) => {
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
      response.status(400).json({ message: 'Invalid agent order.' });
      return;
    }
    await pool.query(
      // Reihenfolge einer Spalte im Workflow-Board; Agents aus anderen Spalten wechseln dabei in diese Phase.
      `UPDATE agents a SET position = o.ord, phase = $2, updated_at = NOW()
         FROM unnest($3::uuid[]) WITH ORDINALITY AS o(id, ord)
        WHERE a.id = o.id AND a.project_slug = $1`,
      [slug, body.phase, body.ids],
    );
    response.status(204).end();
  });

  app.patch('/api/agents/:id', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    const requested = isRecord(request.body) ? request.body.allowedCommands : undefined;
    const fields = parseFields(request.body, AGENT_FIELDS) ?? (requested !== undefined ? [] : null);
    if (!fields) {
      response.status(400).json({ message: 'Invalid agent update.' });
      return;
    }
    if (requested !== undefined) {
      const project = (
        await pool.query<{ slug: string }>('SELECT project_slug AS slug FROM agents WHERE id = $1', [request.params.id])
      ).rows[0]?.slug;
      if (!project) return void response.status(404).json({ message: 'Agent not found.' });
      const commands = await validAgentCommands(pool, project, requested);
      if (typeof commands === 'string') return void response.status(400).json({ message: commands });
      fields.push({ column: 'allowed_commands', value: commands });
    }
    const update = buildUpdate('agents', request.params.id, fields, AGENT_COLUMNS);
    const result = await pool.query(update.sql, update.values);
    if (!result.rows[0]) {
      response.status(404).json({ message: 'Agent not found.' });
      return;
    }
    response.json({ agent: result.rows[0] });
  });

  app.delete('/api/agents/:id', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    const result = await pool.query('DELETE FROM agents WHERE id = $1 RETURNING id', [request.params.id]);
    if (!result.rows[0]) {
      response.status(404).json({ message: 'Agent not found.' });
      return;
    }
    response.status(204).end();
  });
}

/**
 * Ergänzt bestehende Projekte einmalig um den Reviewer (direkt nach dem Tester, mit dem Befehl des Entwicklers).
 * Das Merkmal reviewer_seeded verhindert, dass ein bewusst gelöschter Reviewer wiederkommt.
 */
export async function ensureReviewer(pool: Pool, slug: string): Promise<void> {
  const claimed = await pool.query(
    `UPDATE projects SET reviewer_seeded = TRUE WHERE slug = $1 AND NOT reviewer_seeded RETURNING slug`,
    [slug],
  );
  if (!claimed.rowCount) return;
  const exists = await pool.query(`SELECT 1 FROM agents WHERE project_slug = $1 AND role = 'reviewer'`, [slug]);
  if (exists.rowCount) return;
  const tester = (
    await pool.query<{ position: number }>(
      `SELECT position FROM agents WHERE project_slug = $1 AND role = 'tester' AND phase = 'after_task' ORDER BY position LIMIT 1`,
      [slug],
    )
  ).rows[0];
  const developer = (
    await pool.query<{ command: string[] | null }>(
      `SELECT command FROM agents WHERE project_slug = $1 AND role = 'developer' ORDER BY position LIMIT 1`,
      [slug],
    )
  ).rows[0];
  const position = (tester?.position ?? 0) + 1;
  await pool.query(
    `UPDATE agents SET position = position + 1 WHERE project_slug = $1 AND phase = 'after_task' AND position >= $2`,
    [slug, position],
  );
  const reviewer = DEFAULT_AGENTS.find((agent) => agent.role === 'reviewer')!;
  await pool.query(
    `INSERT INTO agents (project_slug, name, role, phase, position, instructions, command)
     VALUES ($1, $2, 'reviewer', 'after_task', $3, $4, $5)`,
    [slug, reviewer.name, position, reviewer.instructions, developer?.command ?? null],
  );
}
