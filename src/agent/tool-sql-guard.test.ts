import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionConfig, MAX_DML_ROWS, runProjectSql, sqlViolation, type SqlClient } from './tool-sql.js';

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
  // Seit der Zeilengrenze für DML: in WITH (…) und hinter EXPLAIN auch mit WHERE nicht, rowCount zählte sie nicht.
  for (const sql of [
    'WITH d AS (DELETE FROM orders WHERE id = 1 RETURNING 1) SELECT count(*) FROM d',
    'EXPLAIN ANALYZE UPDATE orders SET a = 1 WHERE id = 1',
    'WITH a AS (SELECT 1), d AS (UPDATE orders SET a = 1 WHERE id = 1 RETURNING 1) SELECT * FROM d',
  ]) {
    assert.match(sqlViolation(sql) ?? '', /in WITH \(…\) oder hinter EXPLAIN/, sql);
  }
  assert.equal(sqlViolation('WITH x AS (SELECT id FROM o) DELETE FROM orders WHERE id IN (SELECT id FROM x)'), null);
  assert.equal(sqlViolation('EXPLAIN SELECT * FROM orders'), null);
});

test('SQL-Wächter: Funktionen, die SQL aus einem String ausführen, sind gesperrt', () => {
  for (const sql of [
    "SELECT query_to_xml('select pg_read_file(''/etc/passwd'')', true, false, '')",
    "SELECT query_to_xmlschema('select pg_ls_dir(''.'')', true, false, '')",
    "SELECT query_to_xml_and_xmlschema('select 1', true, false, '')",
    "SELECT cursor_to_xml('c', 10, true, false, '')",
    "SELECT table_to_xml('pg_authid', true, false, '')",
    "SELECT * FROM ts_stat('select pg_read_file(''/etc/passwd'')::tsvector')",
    "SELECT ts_rewrite('a'::tsquery, 'select pg_ls_dir(''.'')')",
    `SELECT "query_to_xml"('select 1', true, false, '')`,
    "SELECT pg_catalog.query_to_xml('select 1', true, false, '')",
    `SELECT pg_catalog."ts_stat"('select 1')`,
  ]) {
    assert.match(sqlViolation(sql) ?? '', /SQL aus einem String/, sql);
  }
  // Der Name in einem String oder Kommentar ist kein Aufruf.
  assert.equal(sqlViolation("SELECT 'query_to_xml' AS name -- ts_stat"), null);
});

test('SQL-Wächter: ALTER TABLE nur mit ADD', () => {
  for (const sql of [
    'ALTER TABLE orders DISABLE TRIGGER ALL',
    'ALTER TABLE orders RENAME TO orders_old',
    'ALTER TABLE orders RENAME COLUMN a TO b',
    'ALTER TABLE orders ALTER COLUMN amount TYPE int USING 0',
    'ALTER TABLE orders DISABLE ROW LEVEL SECURITY',
    'ALTER TABLE orders OWNER TO someone',
    'ALTER TABLE orders ADD COLUMN note text, OWNER TO someone',
    'ALTER TABLE IF EXISTS ONLY public."Orders" ENABLE ALWAYS TRIGGER t',
  ]) {
    assert.match(sqlViolation(sql) ?? '', /ALTER TABLE nur mit ADD/, sql);
  }
  for (const sql of [
    'ALTER TABLE orders ADD COLUMN note text',
    'ALTER TABLE IF EXISTS public."Orders" ADD COLUMN amount numeric(10, 2), ADD CONSTRAINT c CHECK (amount IN (1, 2))',
    'ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE',
  ]) {
    assert.equal(sqlViolation(sql), null, sql);
  }
});

test('SQL-Wächter: nur erlaubte Anweisungsarten (Allowlist)', () => {
  for (const sql of [
    'CREATE OR REPLACE VIEW v AS SELECT 1',
    'DROP INDEX orders_idx',
    'DROP FOREIGN TABLE remote_orders',
    "LOAD 'plpgsql'",
    'ALTER INDEX orders_idx RENAME TO x',
    'ALTER VIEW v OWNER TO someone',
    'VACUUM FULL orders',
    'REINDEX TABLE orders',
    'LOCK TABLE orders',
    'CALL p()',
    'MERGE INTO t USING s ON t.id = s.id WHEN NOT MATCHED THEN INSERT VALUES (s.id)',
    'NOTIFY c',
    'REFRESH MATERIALIZED VIEW mv',
    'IMPORT FOREIGN SCHEMA s FROM SERVER x INTO public',
    '(SELECT 1)',
  ]) {
    assert.match(sqlViolation(sql) ?? '', /Nicht erlaubt/, sql);
  }
  assert.match(sqlViolation('DROP INDEX orders_idx') ?? '', /DROP INDEX/);
  // MERGE … THEN DELETE scheitert schon an der WHERE-Prüfung.
  assert.ok(sqlViolation('MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE'));
  for (const sql of [
    'SELECT 1',
    'select * from orders where id = 1 for update',
    'VALUES (1), (2)',
    'TABLE orders',
    'SHOW search_path',
    "INSERT INTO orders (a) VALUES ('x') RETURNING id",
    'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x',
    'EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM orders',
    'CREATE TABLE IF NOT EXISTS t (id int REFERENCES u (id) ON DELETE CASCADE)',
    'CREATE TEMP TABLE t AS SELECT 1',
    'CREATE UNIQUE INDEX t_idx ON t (id)',
    'CREATE VIEW v AS SELECT 1',
    'CREATE MATERIALIZED VIEW mv AS SELECT 1',
    'CREATE SEQUENCE s',
    'CREATE SCHEMA app',
  ]) {
    assert.equal(sqlViolation(sql), null, sql);
  }
});

test('SQL-Wächter: Klammern verstecken keine triviale WHERE-Bedingung', () => {
  for (const sql of [
    'UPDATE t SET a = 1 WHERE (true)',
    'UPDATE t SET a = 1 WHERE ((1 = 1))',
    'DELETE FROM t WHERE (id = 5) OR (true)',
    'DELETE FROM t WHERE (id IS NOT NULL)',
    'DELETE FROM t WHERE NOT (false)',
    'DELETE FROM t WHERE (true) AND (1 = 1) RETURNING id',
    'UPDATE t SET a = (SELECT max(b) FROM u WHERE u.id = 1) WHERE (true)',
  ]) {
    assert.match(sqlViolation(sql) ?? '', /echte WHERE-Bedingung/, sql);
  }
  // WHERE nur in einer Unterabfrage gilt nicht als WHERE der Anweisung.
  assert.match(sqlViolation('UPDATE t SET a = (SELECT b FROM u WHERE u.id = 1)') ?? '', /brauchen eine WHERE/);
  for (const sql of [
    'UPDATE t SET a = 1 WHERE (id = 5)',
    'DELETE FROM t WHERE (true) AND id = 5',
    'DELETE FROM t WHERE id IN (SELECT id FROM u WHERE u.x = 1)',
    'DELETE FROM t WHERE (id = 1) OR (id = 2)',
    'UPDATE t SET a = 1 WHERE id BETWEEN 1 AND 5',
    'DELETE FROM t WHERE EXISTS (SELECT 1 FROM u WHERE u.id = t.id)',
  ]) {
    assert.equal(sqlViolation(sql), null, sql);
  }
});

/** Fake-Client, der für das Nutzer-SQL `command` mit `rowCount` meldet und alle Aufrufe mitschreibt. */
function dmlClient(command: string, rowCount: number) {
  const calls: string[] = [];
  const client: SqlClient = {
    connect: async () => undefined,
    query: async (text) => {
      calls.push(text);
      const own = /^(?:BEGIN|SET|SAVEPOINT|COMMIT|ROLLBACK)\b/.test(text);
      return own ? { command: text.split(' ')[0] } : { command, rowCount, rows: [] };
    },
    end: async () => undefined,
  };
  return { client, calls };
}

test('runProjectSql: UPDATE/DELETE über der Zeilengrenze werden zurückgerollt, INSERT nicht', async () => {
  assert.equal(MAX_DML_ROWS, 500);
  const atLimit = dmlClient('UPDATE', 500);
  const ok = await runProjectSql('postgres://x/proj', 'UPDATE t SET a = 1 WHERE b = 2', () => atLimit.client, {});
  assert.match(ok, /^UPDATE: 500 Zeile/);
  assert.ok(atLimit.calls.includes('COMMIT'));
  assert.ok(!atLimit.calls.includes('ROLLBACK'));

  for (const command of ['UPDATE', 'DELETE']) {
    const over = dmlClient(command, 501);
    const sql = command === 'UPDATE' ? 'UPDATE t SET a = 1 WHERE b = 2' : 'DELETE FROM t WHERE b = 2';
    const result = await runProjectSql('postgres://x/proj', sql, () => over.client, {});
    assert.match(result, new RegExp(`${command} hätte 501 Zeilen geändert \\(Grenze 500\\)`));
    assert.match(result, /nichts gespeichert/);
    // ROLLBACK in derselben Transaktion: nach BEGIN und dem Statement, kein COMMIT.
    assert.deepEqual(over.calls.slice(0, 2), ['BEGIN', 'SET LOCAL statement_timeout = 15000']);
    assert.deepEqual(over.calls.slice(2), [sql, 'ROLLBACK']);
  }

  // INSERT fügt nur hinzu: keine Grenze gewollt.
  const insert = dmlClient('INSERT', 10_000);
  const inserted = await runProjectSql('postgres://x/proj', 'INSERT INTO t SELECT * FROM u', () => insert.client, {});
  assert.match(inserted, /^INSERT: 10000 Zeile/);
  assert.ok(insert.calls.includes('COMMIT'));
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

test('SQL-Wächter: Unicode-Escapes U&"…" und U&\'…\' sind verboten', () => {
  for (const sql of [
    `SELECT U&"\\0073et_config"('statement_timeout', '0', false)`,
    `SELECT u&"\\0070g_read_file"('/etc/passwd')`,
    `SELECT U&'\\0041'`,
    `SELECT * FROM t WHERE x = U&'d\\0061t\\+000061'`,
  ]) {
    assert.match(sqlViolation(sql) ?? '', /Unicode-Escapes/, sql);
  }
  // Bitweises UND und U& in Strings oder Kommentaren bleiben erlaubt.
  assert.equal(sqlViolation('SELECT u & 1 FROM t'), null);
  assert.equal(sqlViolation(`SELECT 'U&"x"' -- U&'y'`), null);
});

test('SQL-Wächter: nur eine Anweisung pro Aufruf', () => {
  for (const sql of ['SELECT 1; SELECT 2', 'SELECT pg_sleep(1); SELECT 1;', "INSERT INTO t VALUES ('a;b'); SELECT 1"]) {
    assert.match(sqlViolation(sql) ?? '', /mehrere Anweisungen/, sql);
  }
  assert.equal(sqlViolation('SELECT 1;'), null);
  assert.equal(sqlViolation("SELECT 'a;b' -- ; noch was"), null);
});

test('SQL-Wächter: WHERE-Bedingungen, die jede Zeile treffen, gelten nicht als echte Bedingung', () => {
  for (const sql of [
    'DELETE FROM users WHERE id IS NOT NULL',
    'DELETE FROM users WHERE 2>1',
    'UPDATE users SET a = 1 WHERE 1 <> 2',
    'DELETE FROM users WHERE id = 5 OR true',
    'DELETE FROM users WHERE NOT false RETURNING id',
    'UPDATE users SET a = 1 WHERE id >= id',
    "DELETE FROM users WHERE 'x' <> 'y'",
    'DELETE FROM users WHERE id NOTNULL',
  ]) {
    assert.match(sqlViolation(sql) ?? '', /echte WHERE-Bedingung/, sql);
  }
  for (const sql of [
    'DELETE FROM users WHERE id = 5',
    'UPDATE users SET a = 1 WHERE id IN (1, 2)',
    'DELETE FROM users WHERE (id = 5)',
    'DELETE FROM users WHERE id = 5 AND email IS NOT NULL',
    'DELETE FROM users WHERE deleted_at IS NULL AND id > 10',
  ]) {
    assert.equal(sqlViolation(sql), null, sql);
  }
});

/** Fake-Client mit Zeilen-Stream: liefert `rows` Zeilen einzeln aus, solange niemand abbricht. */
function streamingClient(rows: number, makeRow: (index: number) => unknown = (index) => ({ id: index })) {
  const state = { calls: [] as string[], streamed: 0, cancelled: false, ended: false };
  const client: SqlClient = {
    connect: async () => undefined,
    query: async (text) => {
      state.calls.push(text);
      return { command: text.split(' ')[0], rowCount: 0, rows: [] };
    },
    queryRows: async (text, onRow) => {
      state.calls.push(text);
      for (let index = 0; index < rows && !state.cancelled && !state.ended; index += 1) {
        state.streamed += 1;
        onRow(makeRow(index));
      }
      if (state.cancelled) throw new Error('canceling statement due to user request');
      return { command: 'SELECT', rowCount: rows };
    },
    cancel: async () => {
      state.cancelled = true;
    },
    end: async () => {
      state.ended = true;
    },
  };
  return { client, state };
}

test('runProjectSql: Zeitlimits stehen in der Verbindungskonfiguration, nicht nur im SQL', async () => {
  const config = connectionConfig('postgres://x/proj');
  assert.match(String(config.options), /-c statement_timeout=15000\b/);
  assert.match(String(config.options), /-c lock_timeout=\d+/);
  assert.match(String(config.options), /-c idle_in_transaction_session_timeout=\d+/);
  assert.ok(Number(config.query_timeout) > 15_000);
  assert.ok(Number(config.connectionTimeoutMillis) > 0);
  // Die Fabrik bekommt genau diese Konfiguration.
  let received: unknown;
  const { client } = streamingClient(1);
  await runProjectSql(
    'postgres://x/proj',
    'SELECT 1',
    (given) => {
      received = given;
      return client;
    },
    {},
  );
  assert.deepEqual(received, config);
});

test('runProjectSql: höchstens MAX_ROWS Zeilen werden gelesen, darüber bricht die Abfrage auf dem Server ab', async () => {
  const { client, state } = streamingClient(1_000_000);
  const result = await runProjectSql('postgres://x/proj', 'SELECT * FROM grosse_tabelle', () => client, {});
  assert.match(result, /mehr als 50 Zeilen/);
  assert.match(result, /nichts gespeichert/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(state.cancelled, 'pg_cancel_backend über cancel()');
  assert.ok(state.ended, 'Verbindung beendet');
  assert.equal(state.streamed, 51);
  assert.ok(!state.calls.includes('COMMIT'));
  const shown = JSON.parse(result.slice(result.indexOf('\n') + 1)) as unknown[];
  assert.equal(shown.length, 50);
});

test('runProjectSql: Byte-Grenze beim Lesen und gekürzte Zellen', async () => {
  const wide = streamingClient(100, () => ({ blob: 'x'.repeat(200_000) }));
  const tooBig = await runProjectSql('postgres://x/proj', 'SELECT blob FROM t', () => wide.client, {});
  assert.match(tooBig, /mehr als 1 MB/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(wide.state.cancelled && wide.state.ended);
  assert.ok(wide.state.streamed <= 6, `gelesen: ${wide.state.streamed}`);

  const cells = streamingClient(2, (index) => ({ id: index, text: 'y'.repeat(5_000), data: Buffer.alloc(3_000) }));
  const clipped = await runProjectSql('postgres://x/proj', 'SELECT * FROM t', () => cells.client, {});
  assert.match(clipped, /^SELECT: 2 Zeile\(n\)\n/);
  const rows = JSON.parse(clipped.split('\n')[1] ?? '') as { id: number; text: string; data: string }[];
  assert.equal(rows.length, 2);
  assert.match(rows[0]?.text ?? '', /^y{500}… \[gekürzt, 5000 Zeichen\]$/);
  assert.match(rows[0]?.data ?? '', /^\\x0{498}… \[gekürzt, 6002 Zeichen\]$/);
  assert.ok(cells.state.calls.includes('COMMIT'));
});

test('runProjectSql: Abbruchsignal und Client-Zeitlimit beenden eine hängende Abfrage', async (t) => {
  const hanging = () => {
    const state = { cancelled: false, ended: false };
    const client: SqlClient = {
      connect: async () => undefined,
      query: async () => ({ command: 'BEGIN' }),
      queryRows: () => new Promise(() => undefined),
      cancel: async () => {
        state.cancelled = true;
      },
      end: async () => {
        state.ended = true;
      },
    };
    return { client, state };
  };
  const controller = new AbortController();
  const first = hanging();
  const pending = runProjectSql('postgres://x/proj', 'SELECT pg_sleep(1e6)', () => first.client, {}, controller.signal);
  setTimeout(() => controller.abort(), 10);
  assert.match(await pending, /abgebrochen/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(first.state.cancelled && first.state.ended);

  // Bereits abgebrochen: keine Verbindung.
  let created = false;
  const aborted = AbortSignal.abort();
  const factory = (): SqlClient => {
    created = true;
    return first.client;
  };
  assert.match(await runProjectSql('postgres://x/proj', 'SELECT 1', factory, {}, aborted), /abgebrochen/);
  assert.equal(created, false);

  // Client-Zeitlimit mit gemockter Uhr.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const second = hanging();
  const timed = runProjectSql('postgres://x/proj', 'SELECT pg_sleep(1e6)', () => second.client, {});
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(20_000);
  assert.match(await timed, /Zeitlimit/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(second.state.cancelled && second.state.ended);
});

test('runProjectSql: ohne offene Transaktion oder bei Rollback durch den Server kein Erfolg', async () => {
  const client = (fail: 'savepoint' | 'commit'): SqlClient => ({
    connect: async () => undefined,
    query: async (text) => {
      if (fail === 'savepoint' && text.startsWith('SAVEPOINT')) {
        throw new Error('SAVEPOINT can only be used in transaction blocks');
      }
      return { command: text === 'COMMIT' && fail === 'commit' ? 'ROLLBACK' : 'SELECT', rowCount: 1, rows: [] };
    },
    end: async () => undefined,
  });
  assert.match(await runProjectSql('postgres://x/proj', 'SELECT 1', () => client('savepoint'), {}), /nicht mehr offen/);
  assert.match(await runProjectSql('postgres://x/proj', 'SELECT 1', () => client('commit'), {}), /zurückgerollt/);
});

test('runProjectSql: Fehlermeldungen enthalten den Datenbank-Zugang nicht', async () => {
  const url = 'postgres://user:geheim@db/proj';
  const client: SqlClient = {
    connect: async () => {
      throw new Error(`connect failed for ${url}`);
    },
    query: async () => ({}),
    end: async () => undefined,
  };
  const result = await runProjectSql(url, 'SELECT 1', () => client, {});
  assert.doesNotMatch(result, /geheim/);
});
