import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { loadProjectPermissions } from '../agent/tool-permissions.js';
import { loadProjectContext } from '../core/project-context.js';
import { loadTotpSecret } from './auth.js';

const failing = (code?: string) =>
  ({
    query: async () => {
      throw Object.assign(new Error('Datenbank weg'), { code });
    },
  }) as unknown as Pool;

test('a database error does not enable every permission group', async () => {
  await assert.rejects(loadProjectPermissions(failing('ECONNREFUSED'), 'demo'), /Datenbank weg/);
});

test('a database error does not switch off the second factor', async () => {
  await assert.rejects(loadTotpSecret(failing('ECONNREFUSED')), /Datenbank weg/);
  assert.equal(await loadTotpSecret(failing('42P01')), null, 'fresh database without the table');
});

test('a database error does not let agents run without the project rules', async () => {
  await assert.rejects(loadProjectContext(failing(), 'demo'), /Datenbank weg/);
});
