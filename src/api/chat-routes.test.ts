import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import type { Pool } from 'pg';
import { registerChatRoutes } from './chat-routes.js';

/** Liest den Stream bis zum Ende; Zeitlimit, damit ein offener Stream den Test nicht hängen lässt. */
async function readUntilEnd(response: Response, timeoutMs: number): Promise<{ ended: boolean; text: string }> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now())),
    ]);
    if (!chunk) break;
    if (chunk.done) return { ended: true, text };
    text += decoder.decode(chunk.value);
  }
  await reader.cancel();
  return { ended: false, text };
}

function streamApp(session: { valid: boolean; member: boolean; active: boolean }, token?: string) {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('FROM auth_sessions')) {
        return {
          rows: session.valid
            ? [{ user_id: 'u1', active: session.active, roles: ['plan'], member: session.member }]
            : [],
        };
      }
      return { rows: [] };
    },
  } as unknown as Pool;
  const app = express();
  app.use((_request, response, next) => {
    if (token) response.locals.sessionToken = token;
    next();
  });
  const router = express.Router();
  registerChatRoutes(router, pool, { recheckMs: 50 });
  app.use('/api', router);
  return app;
}

async function withStream(app: express.Express, action: (url: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    await action(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/alpha/chat/stream`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('Chat-Stream endet nach Logout, Deaktivierung oder entzogener Projektfreigabe', async () => {
  for (const change of [
    (session: { valid: boolean }) => (session.valid = false),
    (session: { active: boolean }) => (session.active = false),
    (session: { member: boolean }) => (session.member = false),
  ]) {
    const session = { valid: true, member: true, active: true };
    await withStream(streamApp(session, 'token'), async (url) => {
      const response = await fetch(url);
      assert.equal(response.status, 200);
      // Erst nach dem Verbindungsaufbau ändert sich die Berechtigung.
      setTimeout(() => change(session), 100);
      const { ended, text } = await readUntilEnd(response, 4000);
      assert.ok(ended, 'Stream wurde beendet');
      assert.match(text, /^data: \[\]/);
    });
  }
});

test('Chat-Stream bleibt offen, solange die Sitzung gilt (und ohne Sitzung, z. B. Basic Auth)', async () => {
  for (const token of ['token', undefined]) {
    await withStream(streamApp({ valid: true, member: true, active: true }, token), async (url) => {
      const { ended, text } = await readUntilEnd(await fetch(url), 1500);
      assert.equal(ended, false);
      assert.match(text, /: ping/);
    });
  }
});
