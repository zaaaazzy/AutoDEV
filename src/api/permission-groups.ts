import type { Router } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import {
  availableGroups,
  CUSTOM_GROUP_ID,
  customRuleProblem,
  loadProjectPermissions,
  availableCommands,
  commandHelp,
  commandLabel,
  normalizeCommands,
  PERMISSION_GROUPS,
} from '../agent/tool-permissions.js';
import { isRecord, normalizeProjectSlug, parseProjectSlug } from '../core/validation.js';

/**
 * Rechte-Gruppen je Projekt (Mandant): eingebaute Gruppen plus eigene, die nur ein Administrator anlegt.
 * Eigene Gruppen gelten ausschliesslich im Projekt, in dem sie angelegt wurden.
 */
const MAX_RULES = 30;

function parseGroup(body: unknown): { label: string; description: string; rules: string[] } | string {
  if (!isRecord(body)) return 'Ungültige Gruppe.';
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, 500) : '';
  const raw = typeof body.rules === 'string' ? body.rules.split('\n') : Array.isArray(body.rules) ? body.rules : null;
  if (!label || label.length > 80) return 'Name der Kategorie: 1–80 Zeichen.';
  if (!raw || !raw.every((rule) => typeof rule === 'string')) return 'Befehle: einer pro Zeile.';
  const rules = [...new Set((raw as string[]).map((rule) => rule.trim()).filter(Boolean))];
  if (!rules.length || rules.length > MAX_RULES) return `Befehle: 1–${MAX_RULES} pro Kategorie.`;
  const problem = rules.map(customRuleProblem).find(Boolean);
  return problem ?? { label, description, rules };
}

/** Prüft die einzeln gesetzten Befehle eines Agents gegen das Projekt (Mandant); null = Projektstandard. */
export async function validAgentCommands(
  pool: Pool,
  project: string,
  value: unknown,
): Promise<string[] | null | string> {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 300 || !value.every((rule) => typeof rule === 'string'))
    return 'Rechte: Liste von Befehlen.';
  const available = availableCommands(await loadProjectPermissions(pool, project));
  const commands = normalizeCommands(value as string[]);
  const unknown = commands.find((rule) => !available.has(rule));
  return unknown ? `Befehl „${unknown}“ ist in diesem Projekt nicht freigegeben.` : commands;
}

export function registerPermissionGroupRoutes(app: Router, pool: Pool): void {
  app.get('/projects/:slug/permission-groups', access({ tenant: 'project' }), async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      if (!slug) return void response.status(404).json({ message: 'Projekt nicht gefunden.' });
      const permissions = await loadProjectPermissions(pool, slug);
      const available = new Set(availableGroups(permissions).map((group) => group.id));
      // Kategorien mit ihren einzelnen Befehlen (Regel und lesbare Bezeichnung).
      const withCommands = (group: { rules: string[] }) => ({
        commands: group.rules.map((rule) => ({ rule, label: commandLabel(rule), help: commandHelp(rule) })),
      });
      response.json({
        groups: [
          ...PERMISSION_GROUPS.map((group) => ({
            ...group,
            ...withCommands(group),
            builtIn: true,
            available: available.has(group.id),
          })),
          ...permissions.custom.map((group) => ({ ...group, ...withCommands(group), builtIn: false, available: true })),
        ],
      });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    '/projects/:slug/permission-groups',
    access({ role: 'admin', tenant: 'project' }),
    async (request, response, next) => {
      try {
        const slug = parseProjectSlug(request.params.slug ?? '');
        const group = parseGroup(request.body);
        if (!slug) return void response.status(404).json({ message: 'Projekt nicht gefunden.' });
        if (typeof group === 'string') return void response.status(400).json({ message: group });
        const id = `x-${normalizeProjectSlug(group.label)}`.slice(0, 40).replace(/-+$/, '');
        if (!CUSTOM_GROUP_ID.test(id) || PERMISSION_GROUPS.some((builtIn) => builtIn.id === id)) {
          return void response.status(400).json({ message: 'Bitte einen anderen Namen wählen.' });
        }
        const row = (
          await pool
            .query(
              `INSERT INTO project_permission_groups (project_slug, id, label, description, rules)
             SELECT slug, $2, $3, $4, $5 FROM projects WHERE slug = $1 RETURNING id, label, description, rules`,
              [slug, id, group.label, group.description, group.rules],
            )
            .catch((error: { code?: string }) => {
              if (error.code === '23505') return null;
              throw error;
            })
        )?.rows[0];
        if (row === undefined) return void response.status(404).json({ message: 'Projekt nicht gefunden.' });
        if (row === null)
          return void response.status(409).json({ message: 'Eine Kategorie mit diesem Namen gibt es schon.' });
        response.status(201).json({ group: { ...row, builtIn: false, available: true } });
      } catch (error) {
        next(error);
      }
    },
  );

  app.patch(
    '/projects/:slug/permission-groups/:id',
    access({ role: 'admin', tenant: 'project' }),
    async (request, response, next) => {
      try {
        const slug = parseProjectSlug(request.params.slug ?? '');
        const group = parseGroup(request.body);
        if (!slug || !CUSTOM_GROUP_ID.test(request.params.id ?? '')) {
          return void response.status(404).json({ message: 'Kategorie nicht gefunden.' });
        }
        if (typeof group === 'string') return void response.status(400).json({ message: group });
        const row = (
          await pool.query(
            `UPDATE project_permission_groups SET label = $3, description = $4, rules = $5
            WHERE project_slug = $1 AND id = $2 RETURNING id, label, description, rules`,
            [slug, request.params.id, group.label, group.description, group.rules],
          )
        ).rows[0];
        if (!row) return void response.status(404).json({ message: 'Kategorie nicht gefunden.' });
        response.json({ group: { ...row, builtIn: false, available: true } });
      } catch (error) {
        next(error);
      }
    },
  );

  app.delete(
    '/projects/:slug/permission-groups/:id',
    access({ role: 'admin', tenant: 'project' }),
    async (request, response, next) => {
      try {
        const slug = parseProjectSlug(request.params.slug ?? '');
        if (!slug || !CUSTOM_GROUP_ID.test(request.params.id ?? '')) {
          return void response.status(404).json({ message: 'Kategorie nicht gefunden.' });
        }
        const deleted = await pool.query<{ rules: string[] }>(
          'DELETE FROM project_permission_groups WHERE project_slug = $1 AND id = $2 RETURNING rules',
          [slug, request.params.id],
        );
        if (!deleted.rows[0]) return void response.status(404).json({ message: 'Kategorie nicht gefunden.' });
        // Ihre Befehle verschwinden auch aus den Agents dieses Projekts (sofern keine andere Kategorie sie enthält).
        const still = availableCommands(await loadProjectPermissions(pool, slug));
        const removed = deleted.rows[0].rules.filter((rule) => !still.has(rule));
        await pool.query(
          `UPDATE agents SET allowed_commands = (
             SELECT COALESCE(array_agg(rule), '{}') FROM unnest(allowed_commands) rule WHERE NOT (rule = ANY($2)))
          WHERE project_slug = $1 AND allowed_commands IS NOT NULL`,
          [slug, removed],
        );
        await pool.query(
          `UPDATE projects SET agent_permissions = array_remove(agent_permissions, $2) WHERE slug = $1`,
          [slug, request.params.id],
        );
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );
}
