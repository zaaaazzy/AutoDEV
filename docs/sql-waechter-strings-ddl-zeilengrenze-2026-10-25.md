# SQL-Wächter: SQL in Strings, DDL nur ADD, Zeilengrenze für DML (25.10.2026)

Auftrag dc8e0e76 (Bugfix, Sprint 23, aus dem Code-Review vom 21.10.2026, Stand `a4971e9`).

## Problem
- Der Tokenizer ersetzt String-Inhalte durch `''`. `query_to_xml`, `query_to_xmlschema`, `cursor_to_xml`, `table_to_xml` und `ts_stat` führen SQL aus einem String aus und versteckten so gesperrte Funktionen (`pg_read_file`, `pg_ls_dir`), wenn der DB-Benutzer die Rechte hat.
- Erlaubt war jedes `ALTER TABLE` ohne DROP (`DISABLE TRIGGER ALL`, `RENAME`, `ALTER COLUMN … TYPE … USING`, `DISABLE ROW LEVEL SECURITY`, `OWNER TO`), dazu `CREATE OR REPLACE VIEW`, `DROP INDEX`, `DROP FOREIGN TABLE`, `LOAD`.
- `UPDATE t SET a=1 WHERE (true)` passierte, weil `flatten()` Klammern vor der Prüfung auf triviale Bedingungen ausblendete.
- Ein Fehlgriff konnte eine ganze Spalte überschreiben oder Trigger und RLS abschalten.

## Änderung (`src/agent/tool-sql.ts`)
- **Allowlist der Anweisungsarten** (`allowedStatement`): `SELECT`, `WITH`, `VALUES`, `TABLE`, `SHOW`, `INSERT`, `UPDATE`, `DELETE`, `EXPLAIN` (mit `ANALYZE`/`VERBOSE`), `CREATE TABLE`/`INDEX`/`VIEW`/`MATERIALIZED VIEW`/`SEQUENCE`/`SCHEMA`/`TYPE` ohne `OR REPLACE` und `ALTER TABLE`. Alles andere (`DROP INDEX`, `LOAD`, `MERGE`, `VACUUM`, `ALTER INDEX` …) wird mit einer deutschen Meldung abgelehnt, die die Allowlist nennt.
- **`ALTER TABLE` nur mit `ADD`:** Die Aktionsliste wird an Kommas geteilt, jede Aktion muss mit `ADD` beginnen. `RENAME`, `OWNER TO`, `DISABLE …`, `ALTER COLUMN … TYPE` scheitern.
- **String-SQL-Funktionen in `FORBIDDEN_SQL`:** `query_to_xml*`, `cursor_to_xml*`, `table_to_xml*`, `schema_to_xml*`, `database_to_xml*`, `ts_stat`, `ts_rewrite`. Die Prüfung greift auch bei Schema-Präfix und in Anführungszeichen. Die Liste der Server-Funktionen wurde um `pg_stat_file`, `pg_file_*`, `pg_cancel_backend`, `pg_reload_conf` und `pg_promote` erweitert.
- **`WHERE (true)` und Verwandte:** `trivialWhere` heißt jetzt `trivialCondition` und arbeitet auf dem ungeglätteten Text. Neue Hilfen `splitTopLevel` (Teilen außerhalb von Klammern an `OR`/`AND`/`WHERE`/`RETURNING`) und `unwrap` (äußere Klammern entfernen). Triviale Bedingungen, mit `AND` verknüpft oder geklammert, werden erkannt; `(a) OR (b)` bleibt korrekt getrennt. Neue Funktion `dmlViolation`.
- **DML nur als eigene Anweisung:** `dmlStatements` liefert `{ text, nested }`. `UPDATE`/`DELETE` innerhalb einer Klammer (CTE) oder hinter `EXPLAIN` sind gesperrt, auch mit `WHERE`, weil `rowCount` dort die geänderten Zeilen nicht zählt und die Grenze nicht greifen würde. Ein `WITH … SELECT` vor dem DML bleibt erlaubt.
- **Zeilengrenze:** neue Konstante `MAX_DML_ROWS = 500`. In `runProjectSql` wird nach der Ausführung `rowCount` geprüft; bei `UPDATE`/`DELETE` über 500 läuft `ROLLBACK` in derselben Transaktion (nach `BEGIN` und `SET LOCAL statement_timeout`). Die Meldung nennt Befehl und Anzahl. `INSERT` ist nicht begrenzt.
- **`src/agent/ollama-prompts.ts`:** Der Parameter `sql` beschreibt jetzt eine Anweisung, die Grenze von 500 Zeilen und „ALTER TABLE nur ADD“.
- **Handbuch:** Abschnitt `run_sql` in `docs/benutzerhandbuch-dashboard-agents.md` (Allowlist, Regel nur ADD, Zeilengrenze, gesperrte String-Funktionen, zwei neue Meldungen in der Fehlertabelle).

## Tests (`src/agent/tool-sql-guard.test.ts`)
- Alle Beispiele aus dem Auftrag als gesperrte Fälle, jeweils mit Gegenproben für erlaubte Formen (u. a. `ALTER TABLE … ADD COLUMN`, `CREATE VIEW`).
- Zeilengrenze: genau 500 geht durch, 501 bei `UPDATE` und `DELETE` wird zurückgerollt (geprüfte Aufruffolge `BEGIN → SET → SQL → ROLLBACK`); `INSERT` mit 10 000 Zeilen bleibt erlaubt.
- Ein bestehender Test wurde bewusst geändert: `WITH d AS (DELETE … WHERE id = 1 …)` wurde vorher als erlaubt erwartet, ist jetzt gesperrt.

## Worauf zu achten ist
- **Verhaltensänderung:** DML in `WITH (…)` oder hinter `EXPLAIN` wird immer abgelehnt. Agents müssen `UPDATE`/`DELETE` als eigene Anweisung senden.
- **Stand der Prüfung:** Der Entwickler konnte die Tests nicht starten (Freigabe für den Befehl fehlte). Es liegt kein Lauf von `npx --no-install tsx --test src/agent/tool-sql-guard.test.ts src/agent/tool-sql.test.ts` vor; die Tester-Abnahme ist maßgeblich. Dabei keine Abdeckungs-Flags verwenden (der Dev-Log-Wächter sperrt `--experimental-test-coverage`).
- Der Wächter bleibt ein Schutz gegen Fehlgriffe des Modells, keine Sicherheitsgrenze. Den eigentlichen Schutz bietet ein Datenbank-Benutzer mit eingeschränkten Rechten in den Projekteinstellungen.
- Die Grenze zählt `rowCount` der Hauptanweisung. Ein `UPDATE`, das über Trigger weitere Zeilen ändert, wird nicht erfasst (eigene Trigger sind ohnehin gesperrt).
- Die Allowlist ist eng: neue Anweisungsarten müssen in `READ_OR_DML` bzw. `ADDITIVE_CREATE` ergänzt werden.

## Geänderte Dateien
`docs/benutzerhandbuch-dashboard-agents.md`, `src/agent/ollama-prompts.ts`, `src/agent/tool-sql.ts`, `src/agent/tool-sql-guard.test.ts`.
