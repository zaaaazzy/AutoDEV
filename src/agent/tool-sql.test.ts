import assert from 'node:assert/strict';
import test from 'node:test';
import { LoopGuard } from './loop-guard.js';
import { runProjectSql, sqlViolation, targetsDevLogDatabase, type SqlClient } from './tool-sql.js';

test('sqlViolation blocks server-level statements and unbounded writes', () => {
  assert.match(sqlViolation('DROP DATABASE x') ?? '', /Nicht erlaubt/);
  assert.match(sqlViolation("select pg_read_file('/etc/passwd')") ?? '', /Nicht erlaubt/);
  assert.match(sqlViolation('DELETE FROM users') ?? '', /WHERE/);
  assert.equal(sqlViolation('UPDATE users SET a = 1 WHERE id = 2; SELECT 1'), null);
  assert.equal(sqlViolation('CREATE TABLE t (id int)'), null);
  assert.equal(sqlViolation('ALTER TABLE t ADD COLUMN note text'), null);
  assert.equal(sqlViolation("UPDATE users SET a = 1 WHERE email = 'x@y.ch' RETURNING id"), null);
  assert.equal(sqlViolation("INSERT INTO todos (title) VALUES ('to do') ON CONFLICT DO NOTHING"), null);
});

test('sqlViolation blocks bulk data loss and dynamic SQL', () => {
  for (const sql of [
    'DROP TABLE users',
    'drop view v',
    'TRUNCATE orders',
    'ALTER TABLE users DROP COLUMN email',
    "DO $$ BEGIN EXECUTE 'select pg_' || 'read_file(''/etc/passwd'')'; END $$",
    'CREATE OR REPLACE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$',
    'SELECT lo_create(0)',
    'DELETE FROM users WHERE true',
    'DELETE FROM users WHERE 1=1',
    'UPDATE users SET a = 1 WHERE id = id',
    "DELETE FROM users WHERE 'a' = 'a' RETURNING *",
  ]) {
    assert.ok(sqlViolation(sql), sql);
  }
});

test('targetsDevLogDatabase compares database names', () => {
  const env = { DEV_LOG_DATABASE_URL: 'postgres://a:b@db:5432/dev_log' };
  assert.equal(targetsDevLogDatabase('postgres://x@h/dev_log', env), true);
  assert.equal(targetsDevLogDatabase('postgres://x@h/shop', env), false);
});

test('runProjectSql runs in a transaction and rolls back on error', async () => {
  const log: string[] = [];
  const client = (fail: boolean): SqlClient => ({
    connect: async () => undefined,
    end: async () => undefined,
    query: async (text: string) => {
      log.push(text.split(' ')[0] ?? '');
      if (fail && text.startsWith('UPDATE')) throw new Error('boom');
      return { command: 'UPDATE', rowCount: 1, rows: [] };
    },
  });
  const ok = await runProjectSql('postgres://x@h/shop', 'UPDATE t SET a = 1 WHERE id = 1', () => client(false), {});
  assert.match(ok, /UPDATE: 1 Zeile/);
  assert.ok(log.includes('COMMIT'));
  log.length = 0;
  const failed = await runProjectSql('postgres://x@h/shop', 'UPDATE t SET a = 1 WHERE id = 1', () => client(true), {});
  assert.match(failed, /SQL-Fehler: boom/);
  assert.ok(log.includes('ROLLBACK'));
});

test('LoopGuard detects repeated paragraphs and identical calls', () => {
  const guard = new LoopGuard();
  const paragraph = 'Ich muss zuerst prüfen, ob der Benutzer existiert und das Passwort gesetzt werden muss.';
  assert.ok(guard.repeatedText(`${paragraph}\n${paragraph}\n${paragraph}`));
  assert.equal(guard.repeatedText(paragraph), null);
  const results = [1, 2, 3, 4].map(() => guard.repeatedCall('read_file', { path: 'a' }));
  assert.deepEqual(results, [false, false, false, true]);
});
