import { systemAgents } from '../agent/system-agents.js';
import type { Express } from 'express';
import type { Pool } from 'pg';
import {
  buildUpdate,
  isRecord,
  isUuid,
  parseBoolean,
  parseCommand,
  parseFields,
  parseLongText,
  parseOption,
  parseProjectSlug,
  parseTitle,
} from '../core/validation.js';

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
const PHASES = new Set(['pre_task', 'while_task', 'after_task']);
const AGENT_COLUMNS = `id, project_slug AS "projectSlug", name, role, phase, position, instructions, enabled, command`;
const AGENT_FIELDS = {
  name: { column: 'name', parse: parseTitle(80) },
  role: { column: 'role', parse: parseOption(ROLES) },
  phase: { column: 'phase', parse: parseOption(PHASES) },
  instructions: { column: 'instructions', parse: parseLongText },
  enabled: { column: 'enabled', parse: parseBoolean },
  command: { column: 'command', parse: parseCommand },
};

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
      'Entwickelt anhand der Angaben des Entwicklers die Tests, führt Build und Tests aus und meldet Fehler als Bug.',
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
}

export function registerAgentRoutes(app: Express, pool: Pool): void {
  app.get('/api/system-agents', async (_request, response) => {
    const row = (await pool.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'system_agents'`))
      .rows[0];
    response.json({ agents: row ? JSON.parse(row.value) : systemAgents() });
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
        ORDER BY CASE phase WHEN 'pre_task' THEN 0 WHEN 'while_task' THEN 1 ELSE 2 END, position, created_at`,
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
    const result = await pool.query(
      `INSERT INTO agents (project_slug, name, role, phase, position, instructions, enabled, command)
       SELECT $1, $2, COALESCE($3, 'custom'), $4, COALESCE(MAX(position), 0) + 1, $5, COALESCE($6, TRUE), $7
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
      `UPDATE agents a SET position = o.ord, updated_at = NOW()
         FROM unnest($3::uuid[]) WITH ORDINALITY AS o(id, ord)
        WHERE a.id = o.id AND a.project_slug = $1 AND a.phase = $2`,
      [slug, body.phase, body.ids],
    );
    response.status(204).end();
  });

  app.patch('/api/agents/:id', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    const fields = parseFields(request.body, AGENT_FIELDS);
    if (!fields) {
      response.status(400).json({ message: 'Invalid agent update.' });
      return;
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
