import type { AddressInfo } from 'node:net';
import express, { type Router } from 'express';
import type { Principal } from './roles.js';

/**
 * Hilfe für Tests: hängt Routen unter /api an einen echten HTTP-Server, mit fest angemeldetem Benutzer.
 * Der zentrale Rechtewächter fehlt hier bewusst; ihn prüfen route-table.test.ts, tenancy.test.ts und roles.test.ts.
 */
export interface RouteClient {
  // JSON der Antwort ungetypt: Die Tests prüfen die Felder selbst.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
  close(): Promise<void>;
}

export async function serveRoutes(principal: Principal, register: (router: Router) => void): Promise<RouteClient> {
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.principal = principal;
    next();
  });
  const router = express.Router();
  register(router);
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return {
    async call(method, path, body) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
