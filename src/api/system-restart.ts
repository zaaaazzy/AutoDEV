import type { Router } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import { cancelRestart, readRestart, requestRestart } from '../runner/system-restart.js';
import type { Principal } from './roles.js';

/** Neustart von AIdeation (Container neu bauen, Worker neu starten): anfordern, abbrechen und lesen nur mit Administration (Mandant `admin`). */
export function registerSystemRestartRoutes(app: Router, pool: Pool): void {
  app.get('/system/restart', access({ tenant: 'admin' }), async (_request, response, next) => {
    try {
      response.json({ restart: await readRestart(pool) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/system/restart', access({ role: 'admin', tenant: 'admin' }), async (request, response, next) => {
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

  // Abbrechen geht nur, solange der Worker noch wartet („requested“); ab „building“ laufen die Container-Builds.
  app.delete('/system/restart', access({ role: 'admin', tenant: 'admin' }), async (_request, response, next) => {
    try {
      const principal = response.locals.principal as Principal | undefined;
      const { state, cancelled } = await cancelRestart(pool, principal?.displayName ?? null);
      if (cancelled) {
        response.json({ restart: state });
        return;
      }
      if (!state) {
        response.status(404).json({ message: 'Es ist kein Neustart angefordert.' });
        return;
      }
      response.status(409).json({
        restart: state,
        message:
          state.status === 'building' || state.status === 'restarting'
            ? 'Der Neubau läuft schon und lässt sich nicht mehr abbrechen.'
            : 'Es wartet kein Neustart mehr.',
      });
    } catch (error) {
      next(error);
    }
  });
}
