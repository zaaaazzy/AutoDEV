# Zentraler JSON-Error-Handler und passendes Body-Limit

## Aufträge

### Auftrag 1557f5f1

Bugfix aus dem Code-Review vom 20.10.2026. Sprint 28, Branch `auftrag/1557f5f1-zentraler-json-error-handler-und`, Commit d8bbd4b (Agent „Entwickler“).

**Problem:** Die API hatte keinen zentralen Error-Handler. Express antwortete bei Fehlern mit HTML, ohne `NODE_ENV=production` sogar mit Stacktrace. Ein kaputtes `%` im Session-Cookie liess `decodeURIComponent` werfen (500). Das JSON-Limit von 32 KB war kleiner als das erlaubte Doku-Maximum von 30'000 Zeichen mit Umlauten. Wer ein langes Handbuch speicherte, bekam 413 als HTML.

**Ergebnis:** Die API antwortet jetzt überall mit JSON, auch bei 404, 413, kaputtem JSON und 500. Ein Stacktrace oder Fehlertext erscheint nie in der Antwort. Das JSON-Limit beträgt 256 KB. Ein Cookie mit kaputtem `%` ergibt 401 statt 500.

**Anforderung → Umsetzung**

- Neue Datei `src/api/error-handler.ts` mit zwei Middlewares:
  - `notFound`: JSON-404 `{ "message": "Nicht gefunden." }` für jede Methode und jeden unbekannten Pfad. Vorher gab es das nur für GET (`app.get('*splat', …)`).
  - `jsonErrors` (vier Parameter, letzte Middleware in `createDevLogApp`):
    - `entity.too.large` oder Status 413 → 413 „Die Anfrage ist zu gross. Bitte den Inhalt kürzen.“
    - `entity.parse.failed` → 400 „Die Anfrage enthält kein gültiges JSON.“
    - sonstiger Status 4xx → derselbe Status, „Die Anfrage ist ungültig.“
    - alles andere → 500 „Interner Fehler. Bitte später erneut versuchen.“ Der Fehler geht nur ins Server-Log (`[api] METHODE /pfad fehlgeschlagen:`), ohne Query-String, weil dort Tokens stehen können.
    - Ist `response.headersSent` gesetzt, ruft der Handler `next(error)` auf.
- `src/api/app.ts`: `app.use(notFound)` und `app.use(jsonErrors)` am Ende. JSON-Limit von `32kb` auf `256kb`. Begründung: Ein Zeichen kostet in JSON bis zu 6 Byte (`\uXXXX`), 30'000 Zeichen brauchen also bis 180 KB, dazu Titel und Notiz.
- `src/api/auth.ts` (`sessionToken`): `decodeURIComponent` in `try/catch`. Ein ungültiges Cookie liefert `null`, die Anfrage ist dann nicht angemeldet (401).
- `src/api/docs.ts`: neue Konstante `MAX_DOC_CONTENT = 30_000`. `src/api/doc-revisions.ts` nutzt sie ebenfalls, die Grenze steht nur noch an einer Stelle.
- `/api/ingest` behält seinen eigenen Fehler-Handler mit 16-KB-Grenze, weil die Route vor dem allgemeinen JSON-Parser läuft.

**Geänderte Dateien:** `src/api/error-handler.ts` (neu), `src/api/app.ts`, `src/api/auth.ts`, `src/api/docs.ts`, `src/api/doc-revisions.ts`, `src/api/app.test.ts`.

**Tests (laut Entwickler, in `src/api/app.test.ts`)**

- Ein Dokument mit 30'000 Umlauten wird gespeichert (201).
- Ein Body von rund 300 KB ergibt 413 als JSON.
- Kaputtes JSON ergibt 400.
- Ein Datenbankfehler ergibt 500 ohne `stack` und ohne Fehlertext.
- Ein Cookie mit kaputtem `%` ergibt 401.
- Unbekannte Pfade ergeben für GET, POST und DELETE ein JSON-404.

Der Grössentest weicht vom Vorschlag des Bug-Wächters ab: Ein 40-KB-Body liegt unter dem neuen Limit und würde nicht mehr abgelehnt. Der Test prüft darum das volle 30'000-Zeichen-Dokument und erzwingt die 413 mit einem Body über 256 KB. Die Dokumentation hat die Tests nicht selbst ausgeführt.

**Worauf zu achten ist**

- Neue Routen dürfen Fehler weiter über `next(error)` oder als Exception weitergeben. Eigene Fehlermeldungen mit Status 4xx, die Routen selbst schicken, bleiben unverändert.
- Mit Status 4xx aus der Middleware (z. B. `http-errors`) kommt nur die generische Meldung „Die Anfrage ist ungültig.“, nicht der Originaltext.
- Grössere Dokumente als 30'000 Zeichen lehnt weiter die Route mit eigener Meldung ab. Wird `MAX_DOC_CONTENT` erhöht, muss das JSON-Limit in `app.ts` mitwachsen (6 Byte je Zeichen).
- Die Bug-Wächter-Einträge („monthly spend limit“) sind Budget-Abbrüche, keine Code-Fehler.

## Sprint

Sprint 28:

| Auftrag | Titel | Zustand |
| --- | --- | --- |
| 1557f5f1 | Zentraler JSON-Error-Handler und passendes Body-Limit | Entwickler fertig (Commit d8bbd4b), Dokumentation hier, Tester/Review/Merge offen |

Weitere Aufträge des Sprints sind in dieser Sitzung nicht bekannt und hier nicht aufgeführt.

## Anfrage / TODO

- `npm test` ausführen und prüfen, dass die neuen Tests in `src/api/app.test.ts` grün sind.
- Manuell prüfen: Ein Handbuch mit 30'000 Zeichen und Umlauten speichern, danach als Revision ansehen. Ein zu langer Body soll die deutsche 413-Meldung zeigen.
- Prüfen, ob die Oberfläche die JSON-Meldung bei 413 und 400 anzeigt (Frontend nicht geändert und nicht geprüft).
- Bug-Wächter-Aufträge nach dem Limit-Reset erneut anstossen.

## Technische Dokumentation

- Fehlerbehandlung der API: `src/api/error-handler.ts`, eingehängt als letzte Middleware in `src/api/app.ts`. Reihenfolge: `registerIngestRoutes` → `sameOriginWrites` → `express.json` (256 KB) → `/api`-Router → statische Dateien und `index.html` → `notFound` → `jsonErrors`.
- Antwortformat bei Fehlern: `{ "message": "<deutscher Text>" }`, Statuscodes 400, 404, 413, 500.
- Cookie-Auswertung: `sessionToken` in `src/api/auth.ts` gibt bei ungültiger Prozentkodierung `null` zurück.
- Doku-Länge: `MAX_DOC_CONTENT` in `src/api/docs.ts`, genutzt von `src/api/doc-revisions.ts`.
