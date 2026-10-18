import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { projectOfRequest, tenantGuard } from './tenancy.js';
import type { Principal } from './roles.js';

const ORDER = '0b6f1c7e-1d2a-4c3b-9e8f-112233445566';
const FOREIGN = '1c6f1c7e-1d2a-4c3b-9e8f-112233445566';

/** Mini-Datenbank: Mitgliedschaften und Datensätze mit Projekt. */
function fakePool(): Pool {
  const owner: Record<string, string> = { [ORDER]: 'alpha', [FOREIGN]: 'beta' };
  return {
    query: async (sql: string, values: unknown[]) => {
      if (sql.includes('project_members')) return { rows: [{ slug: 'alpha' }] };
      const slug = owner[values[0] as string];
      return { rows: slug ? [{ slug }] : [] };
    },
  } as unknown as Pool;
}

async function call(principal: Principal, method: string, path: string): Promise<number> {
  let status = 200;
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
  await new Promise<void>((resolve) => {
    void tenantGuard(fakePool())({ method, path } as never, response as never, () => resolve());
    setTimeout(resolve, 20);
  });
  return status;
}

const member: Principal = {
  id: '2d6f1c7e-1d2a-4c3b-9e8f-112233445566',
  username: 'ana',
  displayName: 'Ana',
  roles: ['plan'],
};
const admin: Principal = { id: null, username: 'admin', displayName: 'Admin', roles: ['admin'] };

test('Projekt einer Anfrage aus Pfad oder Datensatz', async () => {
  assert.equal(await projectOfRequest(fakePool(), '/api/projects/alpha/board'), 'alpha');
  assert.equal(await projectOfRequest(fakePool(), `/api/development/${ORDER}/retry`), 'alpha');
  assert.equal(await projectOfRequest(fakePool(), '/api/development/kein-uuid'), null);
  assert.equal(await projectOfRequest(fakePool(), '/api/unbekannt/x'), undefined);
});

test('Mandantentrennung: eigenes Projekt ja, fremdes nein (404), Unzuordenbares nur für Administration', async () => {
  assert.equal(await call(member, 'GET', '/api/projects/alpha/board'), 200);
  assert.equal(await call(member, 'GET', '/api/projects/beta/board'), 404);
  assert.equal(await call(member, 'PATCH', `/api/development/${ORDER}`), 200);
  assert.equal(await call(member, 'PATCH', `/api/development/${FOREIGN}`), 404);
  assert.equal(await call(member, 'GET', '/api/users'), 403);
  assert.equal(await call(member, 'GET', '/api/setup/jobs/abc'), 403);
  assert.equal(await call(member, 'GET', '/api/projects'), 200);
  assert.equal(await call(admin, 'GET', '/api/projects/beta/board'), 200);
});
