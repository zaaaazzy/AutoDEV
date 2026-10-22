import assert from 'node:assert/strict';
import test from 'node:test';
import { LoopGuard } from './loop-guard.js';
import { runProjectSql, sqlViolation, targetsDevLogDatabase, type SqlClient } from './tool-sql.js';

test('sqlViolation blocks server-level statements and unbounded writes', () => {
  assert.match(sqlViolation('DROP DATABASE x') ?? '', /Nicht erlaubt/);
  assert.match(sqlViolation("select pg_read_file('/etc/passwd')") ?? '', /Nicht erlaubt/);
  assert.match(sqlViolation('DELETE FROM users') ?? '', /WHERE/);
  // Seit dem Auftrag „run_sql: Transaktion, Timeout und Ergebnisgröße“ nur noch eine Anweisung pro Aufruf.
  assert.match(sqlViolation('UPDATE users SET a = 1 WHERE id = 2; SELECT 1') ?? '', /mehrere Anweisungen/);
  assert.equal(sqlViolation('UPDATE users SET a = 1 WHERE id = 2;'), null);
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

test('LoopGuard: Wiederholung in Doku und Trennlinien sind keine Schleife', () => {
  const guard = new LoopGuard();
  const section = (name: string) =>
    `## ${name}\n- **Timeout**: Konfigurierbar (Default: 3000ms) für alle Aufrufe dieses Endpunkts\n` +
    `curl -X GET https://localhost:4200/api/container/status --header "Accept: application/json"\n`;
  // Gleiche Zeilen in vier Abschnitten (nicht direkt hintereinander): Doku, keine Schleife.
  assert.equal(guard.repeatedText(['Status', 'Logs', 'Neustart', 'Health'].map(section).join('\n')), null);
  // Trennlinien zählen nicht, auch wenn sie direkt hintereinander stehen.
  const rule = '='.repeat(60);
  assert.equal(guard.repeatedText(`${rule}\n${rule}\n${rule}\n${rule}`), null);
  // Dieselbe Zeile sehr oft im Text bleibt eine Schleife.
  const line = 'Ich prüfe jetzt noch einmal die Konfiguration des Containers und der Umgebung.';
  assert.ok(
    guard.repeatedText(Array.from({ length: 8 }, (_, index) => `${line}\nZwischenschritt ${index}`).join('\n')),
  );
});
