import type { Express } from 'express';
import type { Pool } from 'pg';
import { readRestart, requestRestart } from '../runner/system-restart.js';
import type { Principal } from './roles.js';

/** Neustart von AIdeation (Container neu bauen, Worker neu starten): anfordern nur mit Administration, lesen alle. */
export function registerSystemRestartRoutes(app: Express, pool: Pool): void {
  app.get('/api/system/restart', async (_request, response, next) => {
    try {
      response.json({ restart: await readRestart(pool) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/system/restart', async (request, response, next) => {
    try {
      const principal = response.locals.principal as Principal | undefined;
      const body = request.body as { comment?: unknown } | undefined;
      const { state, created } = await requestRestart(
        pool,
        principal?.displayName ?? null,
        new Date(),
        typeof body?.comment === 'string' ? body.comment : null,
      );
      response.status(created ? 201 : 409).json({
        restart: state,
        ...(created ? {} : { message: 'Ein Neustart läuft bereits.' }),
      });
    } catch (error) {
      next(error);
    }
  });
}
