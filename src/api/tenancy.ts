import type { Pool } from 'pg';
import { isUuid, parseProjectSlug } from '../core/validation.js';
import type { Principal } from './roles.js';

/**
 * Mandantentrennung: Ein Mandant ist ein Projekt. Administratoren sehen alle Projekte, alle anderen nur die, für
 * die sie freigeschaltet sind (project_members). Jede Route deklariert ihren Mandanten (access in access.ts):
 * über den Pfad (:slug), über den Datensatz (:id) oder ausdrücklich projektübergreifend. Was sich keinem Projekt
 * zuordnen lässt und nicht ausdrücklich projektübergreifend ist, bleibt Administratoren vorbehalten.
 */
export const ENTITY_PROJECT = {
  development: 'SELECT project_slug AS slug FROM development_items WHERE id = $1',
  sprints: 'SELECT project_slug AS slug FROM sprints WHERE id = $1',
  bugs: 'SELECT project_slug AS slug FROM bugs WHERE id = $1',
  ideation: 'SELECT project_slug AS slug FROM ideation_items WHERE id = $1',
  docs: 'SELECT project_slug AS slug FROM docs WHERE id = $1',
  agents: 'SELECT project_slug AS slug FROM agents WHERE id = $1',
  'agent-tasks': 'SELECT project_slug AS slug FROM agent_tasks WHERE id = $1',
  'workflow-steps': 'SELECT project_slug AS slug FROM workflow_steps WHERE id = $1',
  'doc-revisions': 'SELECT d.project_slug AS slug FROM doc_revisions r JOIN docs d ON d.id = r.doc_id WHERE r.id = $1',
  'visual-snapshots': 'SELECT project_slug AS slug FROM visual_snapshots WHERE id = $1',
  'test-media': 'SELECT r.project_slug AS slug FROM test_media m JOIN test_runs r ON r.id = m.run_id WHERE m.id = $1',
  attachments: `SELECT COALESCE(i.project_slug, b.project_slug) AS slug FROM ideation_attachments a
                  LEFT JOIN ideation_items i ON i.id = a.ideation_id LEFT JOIN bugs b ON b.id = a.bug_id WHERE a.id = $1`,
} as const;

export type Entity = keyof typeof ENTITY_PROJECT;

/**
 * Mandant einer Route:
 * - 'global': jeder angemeldete Benutzer, ohne Projektbezug (eigene Sitzung, eigene Geräte, Kataloge); Routen, die
 *   projektübergreifend Daten liefern, filtern selbst nach response.locals.allowedProjects.
 * - 'project': Projekt aus dem Pfadparameter :slug.
 * - Entity (z. B. 'development'): Projekt des Datensatzes aus dem Pfadparameter :id.
 * - 'admin': keinem Projekt zuordenbar, nur Administratoren.
 */
export type Tenant = 'global' | 'admin' | 'project' | Entity;

export function isEntity(value: string): value is Entity {
  return Object.hasOwn(ENTITY_PROJECT, value);
}

export function isAdmin(principal: Principal | undefined): boolean {
  return Boolean(principal?.roles.includes('admin'));
}

/** Projekte, die ein Benutzer sehen darf; null = alle (Administrator). */
export async function allowedProjects(pool: Pool, principal: Principal | undefined): Promise<Set<string> | null> {
  if (!principal) return new Set();
  if (isAdmin(principal)) return null;
  if (!principal.id) return new Set();
  const rows = (
    await pool.query<{ slug: string }>('SELECT project_slug AS slug FROM project_members WHERE user_id = $1', [
      principal.id,
    ])
  ).rows;
  return new Set(rows.map((row) => row.slug));
}

function decoded(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Tabellen mit Spalte project_slug, deren IDs Routen aus Pfad oder Body übernehmen (feste Namen, nie Eingabe). */
export const PROJECT_TABLES = [
  'agents',
  'agent_tasks',
  'bugs',
  'chat_messages',
  'development_items',
  'ideation_items',
  'project_permission_groups',
  'sprints',
  'test_runs',
  'workflow_steps',
] as const;

export type ProjectTable = (typeof PROJECT_TABLES)[number];

/**
 * Gehört die ID (oder jede ID der Liste) zum Projekt mit diesem Slug? Jede Route, die eine ID aus Pfad oder Body
 * übernimmt, prüft sie damit, bevor sie schreibt; der Fremdschlüssel prüft das Projekt nicht. Welche Routen das sind,
 * steht in tenant-id-fields.ts (Test: tenant-ids.test.ts). Ohne ID (null, leere Liste) gibt es nichts zu prüfen.
 * UUIDs vorher mit isUuid prüfen: Postgres lehnt sonst die Abfrage ab.
 */
export async function assertInProject(
  pool: Pool,
  table: ProjectTable,
  id: string | readonly string[] | null | undefined,
  slug: string,
): Promise<boolean> {
  if (!PROJECT_TABLES.includes(table)) throw new Error(`Keine Projekttabelle: ${table}`);
  if (!id) return true;
  if (typeof id === 'string') {
    return !!(await pool.query(`SELECT 1 FROM ${table} WHERE id = $1 AND project_slug = $2`, [id, slug])).rows[0];
  }
  const ids = [...new Set(id)];
  if (!ids.length) return true;
  const found = await pool.query(`SELECT DISTINCT id FROM ${table} WHERE id = ANY($1) AND project_slug = $2`, [
    ids,
    slug,
  ]);
  return found.rows.length === ids.length;
}

/** Projekt einer Anfrage nach dem deklarierten Mandanten und den Pfadparametern; null = keines/unbekannt. */
export async function projectOfTenant(
  pool: Pool,
  tenant: 'project' | Entity,
  params: Record<string, string>,
): Promise<string | null> {
  if (tenant === 'project') {
    const slug = decoded(params.slug);
    return slug === null ? null : parseProjectSlug(slug);
  }
  if (!isUuid(params.id)) return null;
  return (await pool.query<{ slug: string | null }>(ENTITY_PROJECT[tenant], [params.id])).rows[0]?.slug ?? null;
}
