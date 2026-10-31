import type { Router } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import { missingRole, type Principal } from './roles.js';
import {
  isAgentProvider,
  loadProviderLimits,
  type ProviderLimitStatus,
  resumeAfterProviderLimit,
} from '../core/provider-limits.js';

/** Eintrag fürs Dashboard: Status des Anbieters und die Aktionen, die der Server diesem Benutzer erlaubt. */
export interface ProviderLimitView extends ProviderLimitStatus {
  actions: { pay: boolean; resume: boolean };
}

/**
 * „Fortsetzen“ (Limit vergessen, wartende Aufträge freigeben) betrifft das Agent-Konto aller Projekte: nur mit der
 * Rolle „Ausführen“ und Zugriff auf alle Projekte. Den Link zur Seite des Anbieters gibt es nur bei erreichtem Limit.
 */
export function providerLimitViews(
  limits: ProviderLimitStatus[],
  principal: Principal | undefined,
  allowed: Set<string> | null | undefined,
): ProviderLimitView[] {
  const mayResume = !missingRole(principal, 'run') && allowed === null;
  return limits.map((limit) => ({
    ...limit,
    actions: { pay: limit.status === 'limited', resume: limit.status === 'limited' && mayResume },
  }));
}

export function registerProviderLimitRoutes(app: Router, pool: Pool): void {
  app.get('/agent-limits', access({ tenant: 'global' }), async (_request, response, next) => {
    try {
      const views = providerLimitViews(
        await loadProviderLimits(pool),
        response.locals.principal as Principal | undefined,
        response.locals.allowedProjects as Set<string> | null | undefined,
      );
      response.set('Cache-Control', 'no-store').json({ providers: views });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    '/agent-limits/:provider/resume',
    access({ role: 'run', tenant: 'global' }),
    async (request, response, next) => {
      try {
        const provider = request.params.provider;
        if (!isAgentProvider(provider)) {
          response.status(404).json({ message: 'Unbekannter Anbieter.' });
          return;
        }
        if (response.locals.allowedProjects !== null) {
          response.status(403).json({ message: 'Fortsetzen betrifft alle Projekte und braucht Zugriff auf alle.' });
          return;
        }
        const limit = (await loadProviderLimits(pool)).find((entry) => entry.provider === provider);
        if (limit?.status !== 'limited') {
          response.status(409).json({ message: 'Für diesen Anbieter ist kein Limit vermerkt.' });
          return;
        }
        const released = await resumeAfterProviderLimit(pool, provider, null);
        response.json({ released });
      } catch (error) {
        next(error);
      }
    },
  );
}
