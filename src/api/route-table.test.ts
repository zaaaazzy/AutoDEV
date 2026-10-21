import type { Router } from 'express';
import type { Pool } from 'pg';
import { type Access, findRoute, routeGuard, routeTable, type RouteEntry } from './access.js';
import { createApiRouter } from './app.js';
import type { Principal, RoleRequirement } from './roles.js';

/**
 * Hilfen für Tests: die Rechte-Deklarationen aller registrierten API-Routen (mit Anmeldung, wie im Betrieb).
 * Pfade wie in der Anfrage, also mit /api.
 */
let router: Router | undefined;

export function apiRouter(): Router {
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
  router ??= createApiRouter(pool, { username: 'admin', password: 'geheim' });
  return router;
}

export function apiRoutes(): RouteEntry[] {
  return routeTable(apiRouter());
}

const withinApi = (path: string): string => path.replace(/^\/api(?=\/)/, '');

/** Deklaration, die für die Anfrage gilt; undefined = keine Route oder undeklariert. */
export function declaredAccess(method: string, path: string): Access | undefined {
  return findRoute(apiRoutes(), method, withinApi(path))?.entry.access;
}

/** Rolle, die eine schreibende Anfrage braucht (null = jeder angemeldete); ohne Deklaration Administration. */
export function requiredRole(method: string, path: string, body: unknown): RoleRequirement | null {
  const declared = declaredAccess(method, path);
  if (!declared || declared.role === undefined) return 'admin';
  return typeof declared.role === 'function' ? declared.role(body) : declared.role;
}

/** Statuscode des Rechte- und Mandantenwächters für eine Anfrage an die echten API-Routen (200 = durchgelassen). */
export async function guardStatus(
  pool: Pool,
  principal: Principal | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<number> {
  let status = 0;
  const response = {
    locals: { principal } as Record<string, unknown>,
    status(code: number) {
      status = code;
      return this;
    },
    json() {
      return this;
    },
  };
  let passed = false;
  const next = (error?: unknown) => {
    if (error) throw error;
    passed = true;
  };
  await routeGuard(pool, apiRouter())({ method, path: withinApi(path), body } as never, response as never, next);
  return passed ? 200 : status;
}
