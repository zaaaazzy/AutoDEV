import assert from 'node:assert/strict';
import test from 'node:test';
import { runProjectSql, sqlViolation, type SqlClient } from './tool-sql.js';

test('SQL-Wächter: Kommentarzeichen in Strings verstecken keine Anweisung', () => {
  for (const sql of [
    "SELECT '/*'; DROP TABLE users; SELECT '*/'",
    "SELECT 'x--'; TRUNCATE t",
    "SELECT '/*'; DELETE FROM users; SELECT '*/'",
    "SELECT '--'; DELETE FROM users",
  ]) {
    assert.notEqual(sqlViolation(sql), null, sql);
  }
});

test('SQL-Wächter: Kommentare und Strings mit Schlüsselwörtern bleiben erlaubt', () => {
  assert.equal(sqlViolation("SELECT 'a--b' AS x"), null);
  assert.equal(sqlViolation("SELECT '/* kein Kommentar */' -- echter Kommentar"), null);
  assert.equal(sqlViolation('SELECT 1 /* DROP TABLE x */'), null);
});

test('SQL-Wächter: DELETE/UPDATE in CTE und hinter EXPLAIN brauchen WHERE', () => {
  for (const sql of [
    'WITH d AS (DELETE FROM orders RETURNING 1) SELECT count(*) FROM d',
    'WITH d AS (UPDATE orders SET a = 1 RETURNING 1) SELECT count(*) FROM d',
    'EXPLAIN ANALYZE DELETE FROM orders',
    'EXPLAIN (ANALYZE) UPDATE orders SET a = 1',
    'WITH d AS (DELETE FROM orders WHERE true RETURNING 1) SELECT 1',
  ]) {
    assert.match(sqlViolation(sql) ?? '', /WHERE/, sql);
  }
  assert.equal(sqlViolation('WITH d AS (DELETE FROM orders WHERE id = 1 RETURNING 1) SELECT count(*) FROM d'), null);
  assert.equal(sqlViolation('EXPLAIN SELECT * FROM orders'), null);
});

test('SQL-Wächter: Transaktions- und Timeout-Steuerung im Nutzer-SQL ist verboten', () => {
  for (const sql of [
    'COMMIT; SET statement_timeout = 0',
    'SET statement_timeout = 0',
    'SET LOCAL statement_timeout TO 0',
    'RESET statement_timeout',
    "SELECT set_config('statement_timeout', '0', true)",
    'ROLLBACK',
    'END; SELECT 1',
  ]) {
    assert.notEqual(sqlViolation(sql), null, sql);
  }
});

test('runProjectSql: abgelehntes SQL erreicht die Datenbank nie', async () => {
  const calls: string[] = [];
  const client: SqlClient = {
    connect: async () => undefined,
    query: async (text) => {
      calls.push(text);
      return { command: 'SELECT', rowCount: 0, rows: [] };
    },
    end: async () => undefined,
  };
  const result = await runProjectSql(
    'postgres://x/proj',
    "SELECT '/*'; DROP TABLE users; SELECT '*/'",
    () => client,
    {},
  );
  assert.match(result, /Nicht erlaubt/);
  assert.deepEqual(calls, []);
});
