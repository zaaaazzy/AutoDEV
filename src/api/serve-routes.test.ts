import type { AddressInfo } from 'node:net';
import express, { type Router } from 'express';
import type { Principal } from './roles.js';

/**
 * Hilfe für Tests: hängt Routen unter /api an einen echten HTTP-Server, mit fest angemeldetem Benutzer.
 * Der zentrale Rechtewächter fehlt hier bewusst; ihn prüfen route-table.test.ts, tenancy.test.ts und roles.test.ts.
 * locals ergänzt, was der Wächter sonst setzt (z. B. allowedProjects).
 */
export interface RouteResponse {
  status: number;
  headers: Headers;
  // JSON der Antwort ungetypt: Die Tests prüfen die Felder selbst.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  raw: Buffer;
}

export interface RouteClient {
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<RouteResponse>;
  close(): Promise<void>;
}

export async function serveRoutes(
  principal: Principal,
  register: (router: Router) => void,
  locals: Record<string, unknown> = {},
): Promise<RouteClient> {
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    Object.assign(response.locals, { principal, ...locals });
    next();
  });
  const router = express.Router();
  register(router);
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return {
    async call(method, path, body, headers = {}) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const raw = Buffer.from(await response.arrayBuffer());
      const json = response.headers.get('content-type')?.includes('application/json');
      return {
        status: response.status,
        headers: response.headers,
        body: json && raw.length ? JSON.parse(raw.toString('utf8')) : null,
        raw,
      };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
