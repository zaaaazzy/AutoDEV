import type { NextFunction, RequestHandler, Router } from 'express';
import type { Pool } from 'pg';
import { missingRole, ROLE_INFO, type Principal, type RoleRule } from './roles.js';
import { allowedProjects, projectOfTenant, type Tenant } from './tenancy.js';
import { defined } from '../core/defined.js';

/**
 * Rechte einer Route, deklariert direkt bei der Route:
 *   app.post('/development/:id/retry', access({ role: 'run', tenant: 'development' }), async (request, response) => …)
 *
 * - role: Rolle für schreibende Anfragen (POST/PUT/PATCH/DELETE). null = jeder angemeldete Benutzer, eine Funktion
 *   entscheidet nach dem Body. Lesen (GET/HEAD/OPTIONS) braucht keine Rolle. Fehlt role, gilt Administration.
 * - tenant: Mandant der Route, siehe Tenant in tenancy.ts.
 *
 * Geprüft wird zentral in routeGuard (vor allen Routen, nach der Anmeldung). Die Deklaration selbst lässt die Anfrage
 * nur durch; so funktionieren die Routen auch in Tests, die sie ohne Anmeldung einhängen.
 */
export interface Access {
  role?: RoleRule;
  tenant: Tenant;
}

const ACCESS = Symbol('access');

/**
 * Anfrage und Antwort als unknown: So leitet Express die Pfadparameter der Route weiter aus dem Pfad ab
 * (mit RequestHandler würde request.params zu string | string[]).
 */
type AccessMarker = ((request: unknown, response: unknown, next: NextFunction) => void) & { [ACCESS]: Access };

export function access(declaration: Access): AccessMarker {
  return Object.assign((_request: unknown, _response: unknown, next: NextFunction) => next(), {
    [ACCESS]: declaration,
  });
}

/** Deklaration eines Route-Handlers (erster Handler der Route), sonst undefined. */
export function declarationOf(handler: unknown): Access | undefined {
  return typeof handler === 'function' ? (handler as Partial<AccessMarker>)[ACCESS] : undefined;
}

/** Undeklarierte Routen und Pfade ohne Route: nur Administration (fail-closed). */
const UNDECLARED: Access = { role: 'admin', tenant: 'admin' };
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface RouteEntry {
  method: string;
  path: string;
  access: Access | undefined;
  match: (path: string) => Record<string, string> | null;
}

/**
 * Express-Pfad (nur feste Teile und :parameter) als Muster; null = nicht unterstützt. strict wie beim Router: Ohne
 * strict trifft Express die Route auch mit Schrägstrich am Ende, dann muss der Wächter sie ebenso treffen – sonst
 * fiele „/development/x/“ auf eine andere (schwächere) Regel als die Route, die Express tatsächlich ausführt.
 */
function compile(path: string, strict: boolean): RouteEntry['match'] | null {
  const keys: string[] = [];
  const parts = path.split('/').map((part) => {
    const param = /^:([A-Za-z_]\w*)$/.exec(part);
    if (param) {
      keys.push(defined(param[1]));
      return '([^/]+)';
    }
    return /^[\w.-]*$/.test(part) ? part.replace(/\./g, '\\.') : null;
  });
  if (parts.includes(null)) return null;
  // Wie Express: Groß-/Kleinschreibung zählt (case sensitive routing), ein abschließender Schrägstrich nur mit strict.
  const pattern = new RegExp(`^${parts.join('/')}${strict ? '' : '/?'}$`);
  return (candidate) => {
    const found = pattern.exec(candidate);
    if (!found) return null;
    return Object.fromEntries(keys.map((key, index) => [key, defined(found[index + 1])]));
  };
}

interface RouteLayer {
  route?: { path: unknown; methods: Record<string, boolean>; stack: { handle: unknown }[] };
}

/** Alle Routen eines Routers in Registrierungsreihenfolge, mit Deklaration (erster Handler). */
export function routeTable(router: Router): RouteEntry[] {
  const entries: RouteEntry[] = [];
  // Einstellung des Routers selbst (express.Router({ strict })), damit Wächter und Router dieselbe Route wählen.
  const strict = (router as { strict?: unknown }).strict === true;
  for (const layer of router.stack as RouteLayer[]) {
    const route = layer.route;
    if (!route) continue;
    const path = String(route.path);
    // Nicht unterstützte Pfade (Platzhalter, Muster) treffen nie: Anfragen dorthin brauchen Administration.
    const match = compile(path, strict) ?? (() => null);
    for (const method of Object.keys(route.methods)) {
      entries.push({ method: method.toUpperCase(), path, access: declarationOf(route.stack[0]?.handle), match });
    }
  }
  return entries;
}

/** Route, die Express für die Anfrage wählt (erste passende), mit Parametern; HEAD läuft über GET-Routen. */
export function findRoute(
  table: RouteEntry[],
  method: string,
  path: string,
): { entry: RouteEntry; params: Record<string, string> } | undefined {
  for (const entry of table) {
    const methodFits = entry.method === method || (method === 'HEAD' && entry.method === 'GET') || method === 'OPTIONS';
    const params = methodFits ? entry.match(path) : null;
    if (params) return { entry, params };
  }
  return undefined;
}

/**
 * Prüft jede API-Anfrage gegen die Deklaration ihrer Route: zuerst die Rolle (schreibende Anfragen), dann den
 * Mandanten. Setzt response.locals.allowedProjects (null = alle Projekte) für die Routen.
 */
export function routeGuard(pool: Pool, router: Router): RequestHandler {
  let table: RouteEntry[] | undefined;
  return async (request, response, next) => {
    try {
      // Erst bei der ersten Anfrage lesen: dann sind alle Routen registriert.
      table ??= routeTable(router);
      const found = findRoute(table, request.method, request.path);
      const declared = found?.entry.access ?? UNDECLARED;
      const principal = response.locals.principal as Principal | undefined;
      if (!READS.has(request.method)) {
        const rule = declared.role === undefined ? 'admin' : declared.role;
        const role = missingRole(principal, typeof rule === 'function' ? rule(request.body) : rule);
        if (role) {
          return void response.status(403).json({ message: `Dafür fehlt dir die Rolle „${ROLE_INFO[role].label}“.` });
        }
      }
      const allowed = await allowedProjects(pool, principal);
      response.locals.allowedProjects = allowed;
      if (allowed === null || declared.tenant === 'global') return next();
      if (declared.tenant === 'admin') {
        return void response.status(403).json({ message: 'Dafür braucht es Administrationsrechte.' });
      }
      const project = await projectOfTenant(pool, declared.tenant, found?.params ?? {});
      // Fremde oder unbekannte Projekte sehen gleich aus: nicht gefunden (verrät nicht, dass es sie gibt).
      if (!project || !allowed.has(project)) return void response.status(404).json({ message: 'Nicht gefunden.' });
      next();
    } catch (error) {
      next(error);
    }
  };
}
