# Transaktionen für mehrstufige API-Änderungen

## Aufträge

### Auftrag a8729ffe

Bugfix aus dem Code-Review vom 20.10.2026. Sprint 28, Branch `auftrag/a8729ffe-transaktionen-fur-mehrstufige-ap`, Commit c41fa6c (Agent „Entwickler“).

**Problem:** Die API nutzte praktisch keine Transaktionen. Mehrstufige Änderungen liefen als einzelne Abfragen über den Pool. Bei „Übernehmen“ einer Idee prüfte ein `NOT EXISTS` und ein zweites `UPDATE` setzte den Status. `development_items(ideation_id)` hatte keinen Unique-Index. Ein Doppelklick erzeugte so zwei Aufträge zur selben Idee. Bei einem Fehler zwischen den Schritten blieben Teilzustände zurück (z. B. Idee „angenommen“ ohne Auftrag).

**Ergebnis:** Mehrstufige Änderungen laufen in einer Transaktion auf einer festen Verbindung. Je Idee ist höchstens ein Auftrag möglich, auch bei parallelen Klicks.

**Anforderung → Umsetzung**

- Neuer Helper `withTransaction(pool, work)` in `src/db/transaction.ts`: holt mit `pool.connect()` eine Verbindung, führt `BEGIN`, `work(client)`, `COMMIT` aus. Bei einem Fehler in `work` oder `COMMIT` folgt `ROLLBACK` und der Fehler wird weitergereicht. `release()` steht im `finally`. Scheitert auch das `ROLLBACK`, wird die Verbindung mit `release(error)` verworfen statt in den Pool zurückgegeben.
- `isUniqueViolation(error)` erkennt PostgreSQL-Code `23505`. Der Typ `Queryable` (Pool oder Client) ist ebenfalls dort definiert.
- Migration 19 `ein-auftrag-je-idee` (`src/db/migrations.ts`): Teilindex `development_items_ideation_idx` auf `development_items(ideation_id) WHERE ideation_id IS NOT NULL`. Vorher werden Duplikate bereinigt: Der älteste Auftrag einer Idee behält den Verweis, bei den übrigen wird `ideation_id` auf `NULL` gesetzt. Gelöscht wird nichts.
- `src/api/development.ts`:
  - `promote` (Übernehmen): `INSERT` des Auftrags und `UPDATE` der Idee auf „angenommen“ in einer Transaktion. Ein paralleler zweiter Aufruf scheitert am Index (`23505`) und bekommt wie ein regulärer Zweitaufruf 409.
  - `POST /projects/:slug/development`: antwortet mit 409 `{ field: 'ideationId', message: 'Zu dieser Idee gibt es schon einen Auftrag.' }`, wenn die Idee schon einen Auftrag hat.
  - `DELETE /development/:id`: Löschen des Auftrags und Wiederöffnen der Idee in einer Transaktion.
- `src/api/projects.ts`: Projekt löschen. Der Setup-Job „Ordner löschen“ wird nur zusammen mit dem Löschen des Projekts angelegt. Scheitert das Löschen, bleibt kein Job übrig, der den Ordner später entfernt.
- `src/api/permission-groups.ts`: Kategorie löschen, Befehle aus den Agents entfernen und Projektliste bereinigen in einer Transaktion. Die Prüfung, welche Befehle noch verfügbar sind, läuft über dieselbe Verbindung (`loadProjectPermissions(client, slug)`) und sieht die gelöschte Kategorie schon nicht mehr.
- `src/api/users.ts`: Benutzer anlegen (inkl. Projektzugriff) und ändern (Rollen, Projektzugriff, Abmelden bei Deaktivierung) je in einer Transaktion. Das Passwort wird vor der Transaktion gehasht, damit die Verbindung nicht während des Hashens belegt ist. `saveProjects` nimmt jetzt ein `Queryable`.
- `src/agent/requirements.ts`: Der Auftragsautor legt den Auftrag per `INSERT` an und fängt `23505` ab. Wurde die Idee inzwischen von Hand übernommen, gilt sie als angenommen und es gibt keinen Fehler.
- `src/api/app.test.ts`: Die Test-Attrappe des Pools hat eine `connect()`-Verbindung bekommen.

**Geänderte Dateien:** `src/db/transaction.ts` (neu), `src/db/transaction.test.ts` (neu), `src/db/migrations.ts`, `src/api/development.ts`, `src/api/projects.ts`, `src/api/permission-groups.ts`, `src/api/users.ts`, `src/api/app.test.ts`, `src/agent/requirements.ts`.

**Tests (laut Entwickler, in `src/db/transaction.test.ts`)**

- Helper ohne Datenbank: Erfolg, Fehler im zweiten Schritt, `ROLLBACK` scheitert, `COMMIT` scheitert.
- Gegen die Datenbank: zwei parallele Übernehmen-Aufrufe ergeben genau einmal 201 und einmal 409.
- Ein zweiter Auftrag zur selben Idee wird mit 409 abgelehnt.
- Nach einem Fehler im zweiten Schritt bleibt nichts übrig.
- Löschen öffnet die Idee wieder.
- Migration 19 bereinigt doppelte Aufträge.

Die Datenbank-Tests brauchen PostgreSQL. Ohne Datenbank werden sie übersprungen. Die Dokumentation hat die Tests nicht selbst ausgeführt.

**Worauf zu achten ist**

- In `work` müssen alle Abfragen über `client` laufen, nie über den Pool. Sonst laufen sie ausserhalb der Transaktion.
- Fremdcode mit eigener Wartezeit (Hashen, Dateizugriffe, CLI-Aufrufe) gehört nicht in die Transaktion, sie hält eine Verbindung aus dem Pool.
- Migration 19 verändert Daten: Ältere doppelte Aufträge einer Idee verlieren ihren Verweis auf die Idee. Auftrag, Verlauf und Arbeit bleiben erhalten.
- Neue Routen, die einen Auftrag zu einer Idee anlegen, müssen 23505 abfangen (`isUniqueViolation`) und 409 antworten.
- Nicht umgestellt: Stellen, die in den Fundstellen des Reviews nicht genannt waren. Weitere mehrstufige Änderungen sind nicht geprüft.
- Die Bug-Wächter-Einträge („monthly spend limit“) sind Budget-Abbrüche, keine Code-Fehler.

## Sprint

Sprint 28:

| Auftrag | Titel | Zustand |
| --- | --- | --- |
| a8729ffe | Transaktionen für mehrstufige API-Änderungen | Entwickler fertig (Commit c41fa6c), Dokumentation hier, Tester/Review/Merge offen |
| 1557f5f1 | Zentraler JSON-Error-Handler und passendes Body-Limit | Entwickler fertig (Commit d8bbd4b), siehe `zentraler-json-error-handler-und-body-limit-2026-10-29.md` |

Weitere Aufträge des Sprints sind in dieser Sitzung nicht bekannt und hier nicht aufgeführt.

## Anfrage / TODO

- `npm test` mit laufender PostgreSQL ausführen, damit `src/db/transaction.test.ts` nicht übersprungen wird.
- Vor dem Einspielen von Migration 19 prüfen, ob es doppelte Aufträge je Idee gibt (`SELECT ideation_id, count(*) FROM development_items WHERE ideation_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1`).
- Manuell prüfen: Doppelklick auf „Übernehmen“ erzeugt einen Auftrag. Prüfen, ob die Oberfläche die 409-Antwort verständlich anzeigt (Frontend nicht geändert und nicht geprüft).
- Prüfen, ob weitere mehrstufige Schreibvorgänge in der API Transaktionen brauchen.
- Bug-Wächter-Aufträge nach dem Limit-Reset erneut anstossen.

## Technische Dokumentation

- Helper: `src/db/transaction.ts` (`withTransaction`, `isUniqueViolation`, Typ `Queryable`).
- Schema: Migration 19 `ein-auftrag-je-idee`, Teilindex `development_items_ideation_idx` (nur Zeilen mit `ideation_id IS NOT NULL`).
- Transaktional sind: Übernehmen und Löschen eines Auftrags (`development.ts`), Projekt löschen mit Ordner-Job (`projects.ts`), Kategorie löschen mit Agent-Bereinigung (`permission-groups.ts`), Benutzer anlegen und ändern (`users.ts`).
- Fehlerabbildung: `23505` auf `development_items(ideation_id)` ergibt 409 in `promote` und beim Anlegen eines Auftrags, in `requirements.ts` wird er still ignoriert.
