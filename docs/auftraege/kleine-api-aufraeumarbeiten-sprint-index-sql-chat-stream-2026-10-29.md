# Kleine API-Aufräumarbeiten: Sprint-Index, SQL-Ersetzung, Chat-Stream

Auftrag f9aae445 (Sprint 28). Aus dem Code-Review vom 21.10.2026 (Stand `a4971e9`).

## Problem

- Die Tabelle `sprints` hatte keinen Index auf `project_slug`, obwohl alle Abfragen danach filtern (Seq-Scans bei vielen Sprints).
- `PATCH /development/:id` baute Statuslogik mit `update.sql.replace(', updated_at = NOW()', …)` in generiertes SQL ein. Wird `buildUpdate` geändert, bricht das still.
- Der Chat-Stream (`GET /projects/:slug/chat/stream`) fragte je offener Verbindung jede Sekunde bis zu 100 Nachrichten ab, ohne Obergrenze. n offene Tabs erzeugten n Abfragen pro Sekunde.

## Umsetzung

**Index (Migration 20, `sprints-projekt-index`):** `CREATE INDEX IF NOT EXISTS sprints_project_idx ON sprints (project_slug, status, created_at)`. Der Teilindex `sprints_one_active_idx` deckt nur aktive Sprints ab.

**SQL ohne `replace`:**
- `buildUpdate(table, id, fields, returning, onlyIf?, extra = [])` hat ein neues Argument `extra`: weitere SET-Zuweisungen aus dem Code (z. B. `CASE`-Ausdrücke). Sie dürfen die Feld-Platzhalter nutzen (`$2` = erstes Feld), aber keine eigenen Parameter anlegen.
- `manualEstimateSql` liefert jetzt `string[]` (leer oder eine `estimate_source = CASE …`-Zuweisung) statt eines SQL-Fragments mit führendem Komma.
- Neu: `developmentUpdateExtras(fields, targetSprintStatus?)` in `src/api/development.ts`. Sie sammelt die Zuweisungen für Status (Planen/Backlog), `removed_from_sprint*`, `auto_run = FALSE`, `return_status` und manuellen Start. Jede Spalte erscheint höchstens einmal.
- `ideation.ts` übergibt `manualEstimateSql(fields)` direkt als `extra`.

**Chat-Stream (`src/api/chat-routes.ts`):**
- Takt `STREAM_POLL_MS = 3000` statt 1000 ms.
- `MAX_STREAMS_PER_SESSION = 3` gleichzeitige Streams je Sitzung (Schlüssel: Sitzungstoken, sonst Benutzer, sonst IP). Ein weiterer Tab erhält **429**; das Frontend fällt dann auf sein Ersatz-Polling zurück.
- Alle Ausstiege laufen über `stop()`: Timer löschen, Platz freigeben, Antwort schließen. Es ist mehrfach aufrufbar und hängt an `request.close`, `response.close`, `response.error`, Fehler bei der Abfrage und beendeter Sitzung.
- `registerChatRoutes` nimmt die Optionen `pollMs` und `maxStreamsPerSession` (für Tests).
- Eine Abfrage liest weiterhin bis zu 100 Nachrichten, weil das Frontend den ganzen Verlauf pro Nachricht ersetzt. `LISTEN/NOTIFY` wurde nicht umgesetzt (bräuchte je Verbindung eine eigene DB-Verbindung).

## Tests

- `src/api/development-update.test.ts` (neu): `developmentUpdateExtras` und das erzeugte UPDATE, ohne `replace`.
- `src/api/chat-routes.test.ts`: Takt, Obergrenze (4. Stream → 429), Aufräumen bei Verbindungsende.
- `src/db/schema.test.ts`: Index `sprints_project_idx`.
- `src/core/estimate-calibration.test.ts`: angepasst an den neuen Rückgabetyp von `manualEstimateSql`.

## Geänderte Dateien

- `src/db/migrations.ts`
- `src/core/validation.ts`
- `src/api/development.ts`
- `src/api/ideation.ts`
- `src/api/chat-routes.ts`
- `src/api/chat-routes.test.ts`, `src/api/development-update.test.ts`, `src/core/estimate-calibration.test.ts`, `src/db/schema.test.ts`

Das Frontend ist unverändert.

## Sprint

| Auftrag | Titel | Art | Sprint | Zustand |
|---|---|---|---|---|
| f9aae445 | Kleine API-Aufräumarbeiten: Sprint-Index, SQL-Ersetzung, Chat-Stream | Aufräumen | Sprint 28 | umgesetzt (Entwickler, Commit `5095333`), dokumentiert |

## Anfrage / TODO

- Anfrage: Code-Review vom 21.10.2026 (Stand `a4971e9`), Fundstellen `schema.ts`, `development.ts`, `chat-routes.ts`.
- Offen: `test:unit` wurde vom Entwickler lokal grün gemeldet, aber nicht auf `main` verglichen. Ob der kritische CI-Bug damit erledigt ist, zeigt erst der nächste CI-Lauf.
- Offen: Mit `LISTEN/NOTIFY` ließe sich das Abfragen ganz ersetzen (Folgeauftrag, falls nötig).
- Hinweis: Die Bug-Wächter-Einträge zum „monthly spend limit“ sind Abbrüche der Claude-CLI, keine Codefehler.

## Technische Dokumentation

- Neue SET-Zuweisungen für `buildUpdate` immer über `extra` ergänzen, nie per String-Ersetzung am fertigen SQL. Zusätzliche Parameter sind in `extra` nicht vorgesehen.
- `updated_at = NOW()` hängt `buildUpdate` weiterhin selbst an, nach den `extra`-Zuweisungen.
- Chat-Stream: Die Zähler liegen im Speicher des API-Prozesses (`openStreams`) und gelten je Prozess. Neue Ausstiege müssen `stop()` nutzen, sonst bleibt ein Platz belegt.

## Worauf zu achten ist

- Ein 4. Chat-Tab derselben Sitzung bekommt 429. Das ist gewollt.
- Nachrichten erscheinen im Stream bis zu 3 s verzögert.
