import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import { isUuid, parseProjectSlug } from '../core/validation.js';
import type { Principal } from './roles.js';
import { fullPath } from './security.js';

/**
 * Mandantentrennung: Ein Mandant ist ein Projekt. Administratoren sehen alle Projekte, alle anderen nur die, für
 * die sie freigeschaltet sind (project_members). Jede Anfrage wird einem Projekt zugeordnet – über den Pfad
 * (/api/projects/<slug>/…) oder über den Datensatz (/api/development/<id>/… usw.). Was sich keinem Projekt
 * zuordnen lässt und nicht ausdrücklich projektübergreifend ist, bleibt Administratoren vorbehalten.
 */
const ENTITY_PROJECT: Record<string, string> = {
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
};

/** Für jeden angemeldeten Benutzer erlaubt, ohne Projektbezug (eigene Sitzung, eigene Geräte, Kataloge). */
const GLOBAL_ROUTES: [string, RegExp][] = [
  ['*', /^\/api\/(session|login|logout)$/],
  ['*', /^\/api\/auth\//],
  ['*', /^\/api\/push\//],
  ['GET', /^\/api\/projects$/],
  ['GET', /^\/api\/agent-status$/],
  ['GET', /^\/api\/setup\/(templates|permissions|scope)$/],
  ['GET', /^\/api\/system-agents$/],
  ['GET', /^\/api\/settings$/],
  // Review-Container sind projektübergreifend; die Routen filtern selbst nach allowedProjects.
  ['GET', /^\/api\/review-slots$/],
  ['POST', /^\/api\/review-slots\/\d+\/stop$/],
];

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

/** Projekt einer Anfrage: aus dem Pfad oder über den Datensatz; undefined = kein Projektbezug erkennbar. */
export async function projectOfRequest(pool: Pool, path: string): Promise<string | null | undefined> {
  const project = path.match(/^\/api\/projects\/([^/]+)(?:\/|$)/)?.[1];
  if (project !== undefined) return parseProjectSlug(decodeURIComponent(project));
  const entity = path.match(/^\/api\/([a-z-]+)\/([^/]+)(?:\/|$)/);
  const sql = entity ? ENTITY_PROJECT[entity[1]!] : undefined;
  if (!entity || !sql) return undefined;
  if (!isUuid(entity[2])) return null;
  return (await pool.query<{ slug: string | null }>(sql, [entity[2]])).rows[0]?.slug ?? null;
}

export function tenantGuard(pool: Pool): RequestHandler {
  return async (request, response, next) => {
    try {
      const path = fullPath(request);
      if (!path.startsWith('/api/')) return next();
      const principal = response.locals.principal as Principal | undefined;
      const allowed = await allowedProjects(pool, principal);
      response.locals.allowedProjects = allowed;
      if (allowed === null) return next();
      if (
        GLOBAL_ROUTES.some(([method, pattern]) => (method === '*' || method === request.method) && pattern.test(path))
      )
        return next();
      const project = await projectOfRequest(pool, path);
      if (project === undefined) {
        // Nicht zuordenbar und nicht ausdrücklich global: nur für Administratoren.
        return void response.status(403).json({ message: 'Dafür braucht es Administrationsrechte.' });
      }
      // Fremde oder unbekannte Projekte sehen gleich aus: nicht gefunden (verrät nicht, dass es sie gibt).
      if (!project || !allowed.has(project)) return void response.status(404).json({ message: 'Nicht gefunden.' });
      next();
    } catch (error) {
      next(error);
    }
  };
}
