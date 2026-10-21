import type { Principal } from './roles.js';
import type { Router } from 'express';
import { access } from './access.js';
import type { Pool } from 'pg';
import { sendPush, vapidKeys } from '../core/push.js';

/** Geräte für Push-Nachrichten an- und abmelden, Testnachricht senden. */
export function registerPushRoutes(app: Router, pool: Pool): void {
  app.get('/push/key', access({ tenant: 'global' }), async (_request, response, next) => {
    try {
      response.json({ publicKey: (await vapidKeys(pool)).publicKey });
    } catch (error) {
      next(error);
    }
  });

  app.post('/push/subscribe', access({ role: null, tenant: 'global' }), async (request, response, next) => {
    try {
      const body = (request.body ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
      const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
      const p256dh = typeof body.keys?.p256dh === 'string' ? body.keys.p256dh : '';
      const auth = typeof body.keys?.auth === 'string' ? body.keys.auth : '';
      if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth) {
        response.status(400).json({ message: 'Ungültige Push-Anmeldung.' });
        return;
      }
      // Gerät gehört dem angemeldeten Benutzer (Systemadministrator ohne Konto: system_admin).
      const principal = response.locals.principal as Principal | undefined;
      await pool.query(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, user_id, system_admin)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
           user_id = EXCLUDED.user_id, system_admin = EXCLUDED.system_admin`,
        [
          endpoint,
          p256dh,
          auth,
          (request.get('user-agent') ?? '').slice(0, 300),
          principal?.id ?? null,
          !principal?.id,
        ],
      );
      response.json({ subscribed: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/push/unsubscribe', access({ role: null, tenant: 'global' }), async (request, response, next) => {
    try {
      const endpoint = (request.body as { endpoint?: unknown } | undefined)?.endpoint;
      if (typeof endpoint === 'string')
        await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
      response.json({ subscribed: false });
    } catch (error) {
      next(error);
    }
  });

  app.post('/push/test', access({ role: null, tenant: 'global' }), async (_request, response, next) => {
    try {
      const principal = response.locals.principal as Principal | undefined;
      const sent = await sendPush(
        pool,
        { title: 'AIdeation', body: 'Benachrichtigungen funktionieren. 🎉', url: '#settings', tag: 'test' },
        { self: { id: principal?.id ?? null } },
      );
      response.json({ sent });
    } catch (error) {
      next(error);
    }
  });
}
