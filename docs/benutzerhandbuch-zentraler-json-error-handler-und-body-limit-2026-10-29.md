# Benutzerhandbuch: Fehlermeldungen der API und Grösse von Handbüchern

Dieses Kapitel beschreibt, was du siehst, wenn ein Speichern oder ein Aufruf der API fehlschlägt. Es gilt für alle Projekte und ändert nichts an gespeicherten Daten. Die Änderung betrifft die Antworten der API. Die Oberfläche selbst wurde für diesen Auftrag nicht geändert.

## 1. Was neu ist

- **Jede Fehlerantwort ist JSON.** Vorher kam bei manchen Fehlern eine HTML-Seite. Jetzt steht in der Antwort immer ein Feld `message` mit einem kurzen deutschen Satz.
- **Keine technischen Details in der Antwort.** Stacktrace und Fehlertext aus dem Server erscheinen nie in der Antwort, auch nicht ohne `NODE_ENV=production`. Die Details stehen nur im Server-Log.
- **Grösseres Limit für Handbücher.** Die Grenze für Anfragen steigt von 32 KB auf 256 KB. Ein Handbuch mit 30'000 Zeichen und vielen Umlauten passt jetzt hinein. Vorher wurde es mit 413 abgelehnt.
- **Ungültiges Session-Cookie.** Ein Cookie mit einem kaputten Zeichen (z. B. ein einzelnes `%`) meldet sich jetzt als nicht angemeldet (401). Vorher gab es einen Serverfehler (500).
- **Unbekannte Adressen.** Ein unbekannter Pfad unter der API antwortet mit JSON 404, bei jeder Methode (GET, POST, DELETE …).

## 2. Welche Antwort du bei welchem Fehler bekommst

| Situation | Status | Meldung in `message` |
|---|---|---|
| Anfrage ist grösser als 256 KB | 413 | „Die Anfrage ist zu gross. Bitte den Inhalt kürzen.“ |
| Die Anfrage ist kein gültiges JSON | 400 | „Die Anfrage enthält kein gültiges JSON.“ |
| Andere ungültige Anfrage (4xx) | wie der Fehler, z. B. 400 oder 401 | „Die Anfrage ist ungültig.“ |
| Unbekannter Pfad, z. B. `/api/gibt-es-nicht` | 404 | „Nicht gefunden.“ |
| Interner Fehler auf dem Server | 500 | „Interner Fehler. Bitte später erneut versuchen.“ |
| Session-Cookie ist ungültig | 401 | „Anmeldung erforderlich.“ |

Wenn du eine 500er-Meldung siehst, liegt die Ursache im Server-Log. Dort steht die Methode, der Pfad (ohne Query-String) und der Fehler.

## 3. Grenzen für Handbücher

Das Limit der Anfrage (256 KB) und die Länge eines Dokuments (30'000 Zeichen) sind zwei verschiedene Grenzen:

- **Länge des Dokuments:** höchstens 30'000 Zeichen für den Inhalt und 180 Zeichen für den Titel. Umlaute und Sonderzeichen zählen als ein Zeichen. Diese Grenze gilt für das Anlegen über die API und für Revisionen. Wird sie überschritten, antwortet die API mit 400. Bei Revisionen steht in der Meldung „Titel (max. 180 Zeichen) und Inhalt (max. 30 000 Zeichen) prüfen.“
- **Grösse der Anfrage:** 256 KB für die ganze Anfrage (Titel und Inhalt zusammen). Ein Handbuch mit 30'000 Umlauten braucht etwa 60 KB und liegt weit darunter. Eine Anfrage über 256 KB wird mit 413 abgelehnt. Das passiert nur bei sehr grossen Inhalten oder bei Zeichen, die der Client als `\uXXXX`-Escape schickt.

Die Grenze für Dokumente steht an einer Stelle (`MAX_DOC_CONTENT` in `src/api/docs.ts`). Wer sie erhöht, muss das Limit der Anfrage in `src/api/app.ts` mit anheben, sonst wird das Speichern wieder mit 413 abgelehnt.

## 4. Bedingungen und Ausnahmen

- **Anmeldung:** Ein Cookie mit einem kaputten Wert gilt als nicht angemeldet. Melde dich neu an.
- **Produktions-Rückkanal (`/api/ingest`):** Dieser Endpunkt hat eine eigene Grössenregel und einen eigenen Fehler-Handler. Er ist in diesem Kapitel nicht geprüft. Die Angaben oben gelten für die übrige API.

## 5. Fehlerbehebung

| Meldung oder Zustand | Ursache | Was du tust |
|---|---|---|
| 413 „Die Anfrage ist zu gross“ | Die Anfrage ist über 256 KB, meist durch einen sehr grossen Inhalt. | Inhalt kürzen oder in mehrere Handbücher aufteilen. |
| 400 „Die Anfrage enthält kein gültiges JSON“ | Der Client hat kein gültiges JSON geschickt. Bei der Oberfläche sollte das nicht vorkommen. | Seite neu laden und erneut speichern. Tritt es wieder auf, Server-Log prüfen. |
| 500 „Interner Fehler“ | Ein Fehler auf dem Server, z. B. die Datenbank ist nicht erreichbar. | Später erneut versuchen. Bleibt der Fehler, Server-Log lesen. |
| 401 „Anmeldung erforderlich“ nach dem Anmelden | Das Cookie ist beschädigt. | Abmelden, Browser-Cookies für die Seite löschen und neu anmelden. |
| Eine HTML-Seite statt einer JSON-Meldung | Die Antwort kommt nicht von dieser API, z. B. von einem Proxy davor, oder der Server läuft noch mit altem Stand. | Server neu starten. Hilft das nicht, Proxy-Einstellungen prüfen. |

## 6. Printscreens

Für dieses Kapitel fehlen noch die Aufnahmen. Die App konnte in dieser Umgebung nicht gestartet werden, deshalb gibt es keine Bilder. Nötig wären:

1. Handbuch-Editor mit einem Inhalt über 30'000 Zeichen, Meldung nach dem Speichern.
2. Meldung nach dem Speichern eines Handbuchs mit 413 (Inhalt über 256 KB).
3. Meldung bei 400 (kaputtes JSON), z. B. über die Entwicklerwerkzeuge.
4. Antwort des Servers bei einer unbekannten Adresse (JSON 404) im Browser.

## 7. Nicht geprüft

- Die Tests in `src/api/app.test.ts` wurden in diesem Lauf nicht ausgeführt. Der Entwickler meldet sie als neu, der Tester muss sie bestätigen.
- Die Anzeige der Meldungen in der Oberfläche ist nicht geprüft. Die Oberfläche wurde nicht geändert.
