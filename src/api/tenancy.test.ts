import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { projectOfTenant } from './tenancy.js';
import type { Principal } from './roles.js';
import { guardStatus } from './route-table.test.js';

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

const call = (principal: Principal, method: string, path: string) => guardStatus(fakePool(), principal, method, path);

const member: Principal = {
  id: '2d6f1c7e-1d2a-4c3b-9e8f-112233445566',
  username: 'ana',
  displayName: 'Ana',
  roles: ['plan'],
};
const admin: Principal = { id: null, username: 'admin', displayName: 'Admin', roles: ['admin'] };

test('Projekt einer Anfrage aus Pfadparameter oder Datensatz', async () => {
  assert.equal(await projectOfTenant(fakePool(), 'project', { slug: 'alpha' }), 'alpha');
  assert.equal(await projectOfTenant(fakePool(), 'development', { id: ORDER }), 'alpha');
  assert.equal(await projectOfTenant(fakePool(), 'development', { id: 'kein-uuid' }), null);
  assert.equal(await projectOfTenant(fakePool(), 'project', { slug: '%E0%A4%A' }), null, 'kaputte Kodierung');
});

test('Mandantentrennung: eigenes Projekt ja, fremdes nein (404), Unzuordenbares nur für Administration', async () => {
  assert.equal(await call(member, 'GET', '/api/projects/alpha/board'), 200);
  assert.equal(await call(member, 'GET', '/api/projects/beta/board'), 404);
  assert.equal(await call(member, 'PATCH', `/api/development/${ORDER}`), 200);
  assert.equal(await call(member, 'PATCH', `/api/development/${FOREIGN}`), 404);
  assert.equal(await call(member, 'GET', '/api/users'), 403);
  assert.equal(await call(member, 'GET', '/api/setup/jobs/abc'), 403);
  assert.equal(await call(member, 'GET', '/api/projects'), 200);
  assert.equal(await call(member, 'GET', '/api/unbekannt/x'), 403, 'Pfad ohne Route: nur Administration');
  assert.equal(await call(admin, 'GET', '/api/projects/beta/board'), 200);
});

test('Review-Container: Nicht-Admins kommen durch den Mandantenwächter, Freigeben bleibt Administration', async () => {
  const runner: Principal = { ...member, roles: ['run'] };
  assert.equal(await call(runner, 'GET', '/api/review-slots'), 200);
  assert.equal(await call(runner, 'POST', '/api/review-slots/2/stop'), 200);
  assert.equal(await call(runner, 'PUT', '/api/review-slots/2'), 403);
  assert.equal(await call(runner, 'GET', '/api/review-slots/2'), 403);
  // Starten: eigenes Projekt ja, fremdes nicht gefunden.
  assert.equal(await call(runner, 'POST', '/api/projects/alpha/review-slots/start'), 200);
  assert.equal(await call(runner, 'POST', '/api/projects/beta/review-slots/start'), 404);
  assert.equal(await call(member, 'POST', '/api/review-slots/2/stop'), 403, 'Planung allein stoppt nichts');
});
