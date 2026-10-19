import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMigrations } from './migrations.js';

function fakeClient(applied: number[], failOn?: string) {
  const statements: string[] = [];
  return {
    statements,
    query: async (sql: string, values?: unknown[]) => {
      statements.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
      if (failOn && sql === failOn) throw new Error('kaputt');
      if (sql.startsWith('SELECT version')) return { rows: applied.map((version) => ({ version })) };
      if (sql.startsWith('INSERT INTO schema_migrations')) applied.push(values?.[0] as number);
      return { rows: [] };
    },
  };
}

const MIGRATIONS = [
  { name: 'eins', sql: 'ALTER TABLE a ADD COLUMN x INT' },
  { name: 'zwei', sql: 'ALTER TABLE a ADD COLUMN y INT' },
];

test('applyMigrations runs only pending migrations, in order', async () => {
  const applied = [1];
  const client = fakeClient(applied);
  assert.deepEqual(await applyMigrations(client as never, MIGRATIONS), ['zwei']);
  assert.deepEqual(applied, [1, 2]);
  assert.equal(await applyMigrations(client as never, MIGRATIONS).then((done) => done.length), 0);
});

test('applyMigrations rolls back a failing migration', async () => {
  const client = fakeClient([], MIGRATIONS[0]!.sql);
  await assert.rejects(applyMigrations(client as never, MIGRATIONS), /Migration 1 \(eins\)/);
  assert.ok(client.statements.includes('ROLLBACK'));
});
