# Board: offene Aufträge und Ideen werden immer vollständig geladen

Auftrag 599319af (Bugfix, 24.10.2026).

## Problem

`GET /projects/:slug/board` lieferte Aufträge und Ideen mit `ORDER BY created_at DESC LIMIT 200`, ohne den Status zu beachten. Bei mehr als 200 Aufträgen fehlten ältere geplante, blockierte oder laufende Aufträge in Sprint, Backlog und „Aktionen“. Die serverseitige Sprintplanung kannte sie trotzdem und schlug sie vor.

## Umsetzung

- Offene Einträge werden ohne Limit geladen. Als offen gilt alles, was nicht abgeschlossen ist, auch Einträge ohne Status (`status IS NULL`).
- Abgeschlossene Einträge sind weiter auf die 200 neuesten begrenzt.
  - Aufträge: `done`, `rejected`.
  - Ideen: `accepted`, `rejected`.
- Eine Abfrage je Liste: `UNION ALL` aus „offen“ und „neueste abgeschlossene“, danach `ORDER BY "createdAt" DESC`. Die beiden Mengen schliessen sich aus, es gibt keine Doppelten.
- Der Herkunftsfilter `?source=` für Ideen gilt unverändert für beide Teile.
- Die Statuslisten stehen zentral in `src/core/status.ts` (`CLOSED_DEVELOPMENT_STATUSES`, `CLOSED_IDEATION_STATUSES`).

## Geänderte Dateien

- `src/api/board.ts`: Hilfsfunktion `openAndRecentClosed`, Konstante `CLOSED_LIMIT = 200`.
- `src/core/status.ts`: die zwei Listen abgeschlossener Status.
- `src/api/board.test.ts` (neu): vier Regressionstests.
  - Älterer blockierter Auftrag erscheint trotz 229 neuerer Aufträge.
  - `done`/`rejected` bleiben auf 200 begrenzt, offene nicht.
  - Aufträge ohne Status gelten als offen.
  - Ältere offene Ideen erscheinen trotz 200 neuerer, der Herkunftsfilter gilt weiter.

## Nicht geändert

- Frontend (`project-loader.ts`): übernimmt die Listen unverändert und hängt an keiner festen Zahl 200.
- Sprintplanung (`sprint-planning.ts`): wählt unter `backlog`, `planned`, `blocked`. Das Board zeigt jetzt jeden dieser Aufträge.

## Worauf zu achten ist

- Die Tests laufen gegen eine nachgebaute Datenbank, nicht gegen echtes Postgres. Die Nachbildung wertet Statusfilter, `LIMIT` und `UNION ALL` aus.
- Nach einer Korrektur an dieser Nachbildung (sie las `LIMIT 1` in einem Unter-Select von `DEV_COLUMNS` als Zeilenlimit) wurden die Tests nicht noch einmal gegen den alten `board.ts` ausgeführt. Dass sie dort rot werden, ist erwartet, aber nicht belegt.
- Die Antwort wächst mit der Zahl offener Einträge. Bei sehr vielen offenen Aufträgen wäre echte Paginierung der nächste Schritt.
- Wird ein neuer Endstatus eingeführt, muss er in `src/core/status.ts` zu den Abgeschlossen-Listen. Sonst gilt er als offen und wird nie abgeschnitten.
- Testlauf: `npm run typecheck` und `src/api/board.test.ts` (4 von 4) grün.
